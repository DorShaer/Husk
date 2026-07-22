export interface VoiceMirrorLine {
  ts: string;
  skill: string;
  message: string;
  voice_live: boolean;
}

export interface ExecutionLine {
  ts: string;
  skill: string;
  args: string;
  input: string;
  source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function extractSkillName(toolInput: unknown): string | null {
  if (!isRecord(toolInput) || typeof toolInput.skill !== 'string') {
    return null;
  }

  const skill = toolInput.skill.trim();
  return skill.length > 0 ? skill : null;
}

export function extractSkillArgs(toolInput: unknown): string {
  if (!isRecord(toolInput) || typeof toolInput.args !== 'string') {
    return '';
  }

  return toolInput.args;
}

export function buildVoiceMessage(skill: string): string {
  return `Running the ${skill} skill`;
}

export function buildVoiceMirrorLine(skill: string, ts: string): VoiceMirrorLine {
  return {
    ts,
    skill,
    message: buildVoiceMessage(skill),
    voice_live: false,
  };
}

export function buildExecutionLine(skill: string, args: string, ts: string): ExecutionLine {
  return {
    ts,
    skill,
    args,
    input: args,
    source: 'hook',
  };
}

export function isoZTimestamp(source: string = new Date().toISOString()): string {
  const parsed = new Date(source);
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}
