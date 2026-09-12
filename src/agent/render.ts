import pc from "picocolors";

/**
 * Terminal rendering for the agent. Kept deliberately dependency-light:
 * streaming text writes directly to stdout, tool activity renders as compact
 * one-line cards.
 */
export interface AgentRenderEvents {
  onTextDelta: (text: string) => void;
  onTurnStart: (iteration: number) => void;
  onToolCall: (name: string, args: string) => void;
  onToolResult: (name: string, ok: boolean, output: string) => void;
  onInfo: (line: string) => void;
}

const TOOL_ARG_LIMIT = 120;
const TOOL_RESULT_LIMIT = 400;

export function quietRender(): AgentRenderEvents {
  return {
    onTextDelta: (text) => {
      process.stdout.write(text);
    },
    onTurnStart: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    // Metadata (usage, failover notices, compaction) still surfaces on stderr.
    onInfo: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
}

export function terminalRender(): AgentRenderEvents {
  const write = (line: string): void => {
    process.stdout.write(line);
  };

  return {
    onTextDelta: (text) => {
      process.stdout.write(text);
    },
    onTurnStart: (iteration) => {
      if (iteration > 1) write("\n");
    },
    onToolCall: (name, args) => {
      write(`\n${pc.cyan(`▸ ${name}`)} ${pc.dim(args.length > TOOL_ARG_LIMIT ? `${args.slice(0, TOOL_ARG_LIMIT)}…` : args)}\n`);
    },
    onToolResult: (name, ok, output) => {
      const status = ok ? pc.green("✓") : pc.red("✗");
      const firstLine = output.split("\n").find((line) => line.trim().length > 0) ?? "(no output)";
      write(
        `${status} ${pc.dim(name)} ${pc.dim(firstLine.length > TOOL_RESULT_LIMIT ? `${firstLine.slice(0, TOOL_RESULT_LIMIT)}…` : firstLine)}\n`,
      );
    },
    onInfo: (line) => write(`${pc.dim(line)}\n`),
  };
}

/** Flush helper after streamed text so the next prompt starts on a fresh line. */
export function endTurn(): void {
  process.stdout.write("\n");
}
