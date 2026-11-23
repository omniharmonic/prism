/** A small, strict argument parser: `--flag`, `--key value`, `--key=value`; unknown flags are errors. */
import { CliError, EXIT } from "./exit-codes";

export interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[], spec: { bool: readonly string[]; value: readonly string[] }): Parsed {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--") {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (spec.bool.includes(name)) {
      if (eq !== -1) throw new CliError(EXIT.USAGE, `--${name} takes no value`);
      flags[name] = true;
    } else if (spec.value.includes(name)) {
      const v = eq !== -1 ? a.slice(eq + 1) : rest[++i];
      if (v === undefined || (eq === -1 && v.startsWith("--"))) throw new CliError(EXIT.USAGE, `--${name} needs a value`);
      flags[name] = v;
    } else {
      throw new CliError(EXIT.USAGE, `unknown option --${name} for \`prism ${command}\``);
    }
  }
  return { command, positional, flags };
}

export function str(p: Parsed, name: string): string | undefined {
  const v = p.flags[name];
  return typeof v === "string" ? v : undefined;
}

export function bool(p: Parsed, name: string): boolean {
  return p.flags[name] === true;
}

export function int(p: Parsed, name: string, min: number, max: number): number | undefined {
  const v = str(p, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new CliError(EXIT.USAGE, `--${name} must be a whole number from ${min} to ${max}`);
  return n;
}
