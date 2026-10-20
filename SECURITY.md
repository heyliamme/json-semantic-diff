# Security policy

The extension parses documents you open and renders them in a webview, so bugs that let
the content of a JSON document run script in that webview, or read files you didn't
choose, are taken seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/json-semantic-diff/security/advisories/new),
not public issues. Include steps to reproduce. You should hear back within a week.

## Scope

In scope: script execution or HTML injection from document content (keys, values, file
names), reading files other than the ones the user picked, and anything that sends data
off the machine.
