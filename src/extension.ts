import * as vscode from 'vscode';
import { disposeDartParseService, parseDartFile } from './parser';
import { buildExecutionTreeView } from './executionTree';
import { showExecutionTreePanel } from './webview/panel';

const PARSE_DEBOUNCE_MS = 250;

export function activate(context: vscode.ExtensionContext) {

    console.log('🔥 ThirdEye Activated');

    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        console.log('⚠️ No workspace folder is open. File watcher will not receive events until you open a folder/workspace.');
        return;
    }

    const pattern = new vscode.RelativePattern(folder, '**/*');
    console.log('Watching workspace folder:', folder.uri.fsPath);
    console.log('Watcher glob pattern:', pattern.pattern);

    // Explicitly set ignore flags to false (i.e., DO NOT ignore events).
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    console.log('Watcher created');
    console.log('⏳ ThirdEye: waiting for file changes (next .dart change will log loading → done)…');

    const debounceTimers = new Map<string, NodeJS.Timeout>();

    async function runParseGraph(dartPath: string): Promise<void> {
        console.log('⏳ ThirdEye: loading (read + parse + graph)…', dartPath);
        const wf = vscode.workspace.workspaceFolders?.[0];
        if (!wf) {
            return;
        }
        try {
            const data = await parseDartFile(dartPath, context.extensionPath);
            const tree = buildExecutionTreeView(data);
            showExecutionTreePanel(context, tree);
            console.log('✅ ThirdEye: loading finished — execution tree panel updated');
        } catch (err) {
            console.log('❌ ThirdEye: loading failed — parse error:', err);
        }
    }

    function scheduleParse(dartPath: string): void {
        const prev = debounceTimers.get(dartPath);
        if (prev) {
            clearTimeout(prev);
        }
        debounceTimers.set(
            dartPath,
            setTimeout(() => {
                debounceTimers.delete(dartPath);
                void runParseGraph(dartPath);
            }, PARSE_DEBOUNCE_MS),
        );
    }

    context.subscriptions.push(
        { dispose: () => {
            for (const t of debounceTimers.values()) {
                clearTimeout(t);
            }
            debounceTimers.clear();
            disposeDartParseService();
        } },
        watcher,
        vscode.workspace.onDidCreateFiles((e) => {
            for (const f of e.files) {
                console.log('🧩 onDidCreateFiles:', f.scheme, f.fsPath);
            }
        }),
        vscode.workspace.onDidDeleteFiles((e) => {
            for (const f of e.files) {
                console.log('🧩 onDidDeleteFiles:', f.scheme, f.fsPath);
            }
        }),
        vscode.workspace.onDidRenameFiles((e) => {
            for (const f of e.files) {
                console.log('🧩 onDidRenameFiles:', f.oldUri.fsPath, '->', f.newUri.fsPath);
            }
        }),
        vscode.workspace.onDidSaveTextDocument((doc) => {
            console.log('🧩 onDidSaveTextDocument:', doc.uri.scheme, doc.uri.fsPath);
        }),
        watcher.onDidCreate((uri) => {
            console.log('🟢 watcher.onDidCreate:', uri.scheme, uri.fsPath);
        }),
        watcher.onDidChange((uri) => {
            console.log('🟡 watcher.onDidChange:', uri.scheme, uri.fsPath);

            if (!uri.fsPath.endsWith('.dart')) {
                return;
            }

            scheduleParse(uri.fsPath);
        }),
        watcher.onDidDelete((uri) => {
            console.log('🔴 watcher.onDidDelete:', uri.scheme, uri.fsPath);
        }),
    );
}

export function deactivate() {
    disposeDartParseService();
}