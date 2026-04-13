import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | undefined;

export function showGraphPanel(context: vscode.ExtensionContext, graph: any) {

    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'thirdeyeGraph',
            'ThirdEye Graph',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true
            }
        );

        panel.onDidDispose(() => {
            panel = undefined;
        });
    }

    const htmlPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'graph.html');
    const htmlUri = panel.webview.asWebviewUri(htmlPath);

    panel.webview.html = getHtml(htmlUri);

    panel.webview.postMessage(graph);
}

function getHtml(htmlUri: vscode.Uri) {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { margin:0; background:#0f172a; color:white; font-family:sans-serif; }
            #container { display:flex; height:100vh; }
            #graph { flex:1; position:relative; overflow:auto; }
            #sidebar { width:300px; background:#111827; padding:10px; overflow:auto; }

            .node {
                position:absolute;
                padding:6px 10px;
                border-radius:6px;
                font-size:12px;
                white-space:nowrap;
            }

            .layer-box {
                position:absolute;
                left:10px;
                right:10px;
                height:90px;
                border:1px solid #1f2937;
                border-radius:10px;
                background:#111827;
            }

            .layer-title {
                position:absolute;
                left:10px;
                top:5px;
                font-size:11px;
                color:#9ca3af;
            }
        </style>
    </head>
    <body>
        <div id="container">
            <div id="graph"></div>
            <div id="sidebar"></div>
        </div>

        <script>
            const vscode = acquireVsCodeApi();

            window.addEventListener('message', event => {
                const graph = event.data;
                render(graph);
            });

            function render(graph) {
                const g = document.getElementById('graph');
                g.innerHTML = '';

                const byStep = new Map();
                graph.nodes.forEach(n => {
                    if (n.flowStep === undefined) return;
                    if (!byStep.has(n.flowStep)) byStep.set(n.flowStep, []);
                    byStep.get(n.flowStep).push(n);
                });

                const orderedSteps = [...byStep.keys()].sort((a, b) => a - b);

                const flowTitle = (step) => {
                    if (step !== 0) {
                        return 'Flow ' + step;
                    }
                    if (graph.root) {
                        const rn = graph.nodes.find((x) => x.id === graph.root);
                        if (rn && rn.label) {
                            return 'Flow 0 — ' + rn.label;
                        }
                    }
                    return 'Flow 0';
                };

                let y = 20;

                orderedSteps.forEach(step => {
                    const layer = byStep.get(step);

                    if (!layer || layer.length === 0) {
                        y += 100;
                        return;
                    }

                    const container = document.createElement('div');
                    container.className = 'layer-box';
                    container.style.top = y + 'px';

                    const title = document.createElement('div');
                    title.className = 'layer-title';
                    title.innerText = flowTitle(step);

                    container.appendChild(title);

                    let x = 20;

                    // NODES
                    layer.forEach(n => {
                        const el = document.createElement('div');
                        el.className = 'node';
                        el.innerText = n.label;
                        el.style.left = x + 'px';
                        el.style.top = '30px';
                        el.style.background = n.color;

                        container.appendChild(el);
                        x += 140;
                    });

                    g.appendChild(container);

                    y += 110;
                });

                renderSidebar(graph.symbols);
            }

            function renderSidebar(symbols) {
                const s = document.getElementById('sidebar');

                s.innerHTML =
                    '<h3>Symbol Table</h3>' +
                    '<b>Variables</b>' +
                    symbols.variables.map(v => '<div>'+v+'</div>').join('') +
                    '<hr/>' +
                    '<b>Functions</b>' +
                    symbols.functions.map(v => '<div>'+v+'</div>').join('') +
                    '<hr/>' +
                    '<b>Classes</b>' +
                    symbols.classes.map(v => '<div>'+v+'</div>').join('');
            }
        </script>
    </body>
    </html>
    `;
}