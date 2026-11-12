/**
 * A command and its arguments as one line a person can read without guessing
 * where an argument ends: an argument of plain characters as it is, any
 * other in single quotes (a single quote inside as `'\''`), the way a shell
 * would take it back. `bash -c "a b"` given as three arguments reads
 * `bash -c 'a b'`, never `bash -c a b`. Nothing is cut: what the user is
 * asked to approve, or told was not started, is shown whole.
 */
export function quotedCommand(argv: readonly string[]): string {
  return argv.map((argument) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(argument) ? argument : `'${argument.replace(/'/g, `'\\''`)}'`)).join(" ")
}
