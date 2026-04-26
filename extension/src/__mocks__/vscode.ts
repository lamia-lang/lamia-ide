export const workspace = {
  workspaceFolders: [{ uri: { fsPath: "/tmp/test-workspace" } }],
  getConfiguration: () => ({
    get: () => "",
  }),
};

export const window = {
  withProgress: async (_opts: any, task: any) => task({ report: () => {} }),
  showWarningMessage: async () => undefined,
  showInformationMessage: async () => undefined,
  activeTextEditor: undefined,
};

export const ProgressLocation = { Notification: 1 };
export const Uri = { parse: (s: string) => ({ fsPath: s }) };
export const env = { clipboard: { writeText: () => {} }, openExternal: () => {} };
export const SnippetString = class { constructor(public value: string) {} };
