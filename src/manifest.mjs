import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 白名单命令清单：唯一允许启动的命令、参数结构与限量都以此为准。
// 清单之外的命令、参数取值、脚本路径一律拒绝；不拼接 shell。
const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MANIFEST_PATH = path.join(PROJECT_ROOT, 'manifest', 'commands.json');
const IMPLEMENTED_FRAMINGS = new Set(['ndjson-trailer-v1']);

export async function loadManifest(manifestPath = MANIFEST_PATH) {
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  return validateManifest(raw);
}

function validateManifest(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.commands) || raw.commands.length === 0) {
    throw new Error('命令清单结构无效');
  }
  const commands = new Map();
  for (const entry of raw.commands) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) throw new Error('清单条目缺少 id');
    if (entry.exec !== 'process.execPath') throw new Error(`清单只允许 process.execPath 启动：${entry.id}`);
    if (entry.shell !== false) throw new Error(`清单必须禁用 shell：${entry.id}`);
    if (!IMPLEMENTED_FRAMINGS.has(entry.framing)) throw new Error(`清单声明了未实现的成帧方式：${entry.framing}`);
    if (typeof entry.script !== 'string' || entry.script.length === 0) throw new Error(`清单条目缺少 script：${entry.id}`);
    const scriptPath = path.resolve(PROJECT_ROOT, entry.script);
    if (!scriptPath.startsWith(PROJECT_ROOT + path.sep)) throw new Error(`清单脚本越出项目目录：${entry.id}`);
    if (!Array.isArray(entry.args)) throw new Error(`清单条目缺少参数结构：${entry.id}`);
    const args = entry.args.map((argument, position) => {
      if (!argument || typeof argument.name !== 'string') throw new Error(`参数声明无效：${entry.id}`);
      if (argument.position !== position) throw new Error(`参数位置必须连续声明：${entry.id}.${argument.name}`);
      if (argument.type !== 'enum' || !Array.isArray(argument.values) || argument.values.length === 0) {
        throw new Error(`参数类型未支持：${entry.id}.${argument.name}`);
      }
      return Object.freeze({ name: argument.name, position, type: argument.type, values: Object.freeze([...argument.values]), required: argument.required === true });
    });
    const limits = validateLimits(entry.id, entry.limits);
    commands.set(entry.id, Object.freeze({
      id: entry.id,
      description: typeof entry.description === 'string' ? entry.description : '',
      scriptPath,
      framing: entry.framing,
      args: Object.freeze(args),
      limits,
    }));
  }
  return Object.freeze({ version: 1, commands });
}

function validateLimits(id, limits) {
  if (!limits || typeof limits !== 'object') throw new Error(`清单条目缺少 limits：${id}`);
  const out = {};
  for (const key of ['stderrMaxBytes', 'maxStdoutBytes', 'maxRecords', 'defaultTimeoutMs', 'maxTimeoutMs', 'killGraceMs', 'closeWaitMs']) {
    const value = limits[key];
    if (!Number.isInteger(value) || value < 1) throw new Error(`limits.${key} 必须是正整数：${id}`);
    out[key] = value;
  }
  if (out.defaultTimeoutMs > out.maxTimeoutMs) throw new Error(`defaultTimeoutMs 超过 maxTimeoutMs：${id}`);
  return Object.freeze(out);
}

// 按清单的参数结构构造启动规格。任何越界取值都在这里被拒绝。
export function buildSpawnSpec(entry, params) {
  const argv = [];
  for (const declaration of entry.args) {
    const value = params?.[declaration.name];
    if (value === undefined) {
      if (declaration.required) throw new Error(`缺少白名单要求的参数 ${declaration.name}`);
      continue;
    }
    if (declaration.type === 'enum' && !declaration.values.includes(value)) {
      throw new Error(`白名单拒绝：参数 ${declaration.name} 不允许取值 ${JSON.stringify(value)}`);
    }
    argv[declaration.position] = String(value);
  }
  if (argv.length !== entry.args.length || argv.includes(undefined)) throw new Error('参数结构不完整');
  return {
    command: process.execPath,
    args: [entry.scriptPath, ...argv],
    framing: entry.framing,
    limits: { ...entry.limits },
  };
}
