/**
 * Repo sources and docs as a test judges them: with `\n` line ends, whatever the checkout has. Git for Windows writes CRLF
 * (core.autocrlf, and the Windows runner's default too), and a test that finds a heading by `\n## Title\n` or a snippet by its
 * line ends finds nothing there, and fails on every Windows checkout.
 *
 * Use it for files of the repository that are READ AS TEXT TO BE SEARCHED. Never for a test of what a writer does with line
 * endings (the frontmatter and note writers keep CRLF on purpose): those read their own temp files and must see them as they are.
 */
export const lf = (text: string): string => text.replace(/\r\n/g, '\n')
