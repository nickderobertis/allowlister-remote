/** @param {string[]} args @param {string[]} flags @returns {Record<string, string>} */
export function requiredOptions(args, flags) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!flags.includes(flag) || Object.hasOwn(values, flag))
      throw new Error(`Unknown or duplicate option: ${flag}`);
    if (index + 1 >= args.length || args[index + 1].startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    values[flag] = args[index + 1];
  }
  for (const flag of flags)
    if (!Object.hasOwn(values, flag)) throw new Error(`Missing required option: ${flag}`);
  return values;
}
