export function tokenizeArguments(input: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;

  const push = () => {
    if (token.length > 0) result.push(token);
    token = "";
  };

  for (const character of input) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    token += character;
  }
  if (escaped) token += "\\";
  if (quote) throw new Error("Unclosed quotation mark in advanced flags");
  push();
  return result;
}

export function argumentOptionName(value: string): string {
  return value.split("=", 1)[0];
}

export function hasArgumentOption(input: string, option: string): boolean {
  try {
    return tokenizeArguments(input).some((value) => argumentOptionName(value) === option);
  } catch {
    return false;
  }
}

export function argumentOptionValue(args: string[], option: string): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) return args[index + 1] ?? null;
    if (args[index].startsWith(`${option}=`)) return args[index].slice(option.length + 1) || null;
  }
  return null;
}

export function shellDisplayArgument(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
}
