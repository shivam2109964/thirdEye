import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | undefined;

export function showGraphPanel(context: vscode.ExtensionContext, graph: any) {

    if (!panel) {
        panel = vscode.window.createWebviewPanel(
            'thirdeyeGraph',
            'ThirdEye Graph',
            vscode.ViewColumn.Beside,
            { enableScripts: true }
        );

        panel.onDidDispose(() => {
            panel = undefined;
        });
    }

    panel.webview.html = getHtml();
    panel.webview.postMessage(graph);
}

function getHtml() {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <style>
            body { margin:0; background:#0f172a; font-family:sans-serif; }
            #graph { position:relative; width:100%; height:100vh; }

            .node {
                position:absolute;
                padding:10px 18px;
                border-radius:10px;
                background:#1f2937;
                color:white;
                border:1px solid #374151;
                font-size:13px;
            }

            svg {
                position:absolute;
                top:0;
                left:0;
                width:100%;
                height:100%;
                pointer-events:none;
            }
        </style>
    </head>
    <body>
        <div id="graph"></div>

        <script>
            window.addEventListener('message', e => render(e.data));

            function render(graph){
                const g = document.getElementById('graph');
                g.innerHTML = '';

                const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                g.appendChild(svg);

                // ===== BUILD ADJ LIST (CALL GRAPH) =====
                const adj = new Map();
                const indegree = new Map();

                graph.nodes.forEach(n => {
                    adj.set(n.id, []);
                    indegree.set(n.id, 0);
                });

                graph.edges.forEach(e=>{
                    if(e.type !== 'call') return;

                    adj.get(e.from).push(e.to);
                    indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
                });

                // ===== FIND ROOT (main) =====
                let root = graph.root;
                if(!root){
                    root = graph.nodes.find(n => n.label === 'main')?.id;
                }

                if(!root){
                    root = graph.nodes[0]?.id;
                }

                // ===== BFS LAYOUT =====
                const levels = new Map(); // node → depth
                const queue = [root];
                levels.set(root, 0);

                while(queue.length){
                    const node = queue.shift();
                    const level = levels.get(node);

                    (adj.get(node) || []).forEach(child=>{
                        if(!levels.has(child)){
                            levels.set(child, level + 1);
                            queue.push(child);
                        }
                    });
                }

                // ===== GROUP BY LEVEL =====
                const levelMap = new Map();

                levels.forEach((lvl, node)=>{
                    if(!levelMap.has(lvl)) levelMap.set(lvl, []);
                    levelMap.get(lvl).push(node);
                });

                // ===== POSITION NODES =====
                const nodePos = new Map();

                const levelKeys = [...levelMap.keys()].sort((a,b)=>a-b);

                levelKeys.forEach((lvl)=>{
                    const nodes = levelMap.get(lvl);

                    const y = 100 + lvl * 150;

                    const totalWidth = nodes.length * 180;
                    let startX = (window.innerWidth - totalWidth) / 2;

                    nodes.forEach((id, i)=>{
                        const node = graph.nodes.find(n=>n.id===id);

                        const x = startX + i * 180;

                        nodePos.set(id, {x, y});

                        const el = document.createElement('div');
                        el.className = 'node';
                        el.innerText = node.label;

                        el.style.left = x + 'px';
                        el.style.top = y + 'px';

                        g.appendChild(el);
                    });
                });

                // ===== DRAW EDGES =====
                graph.edges.forEach(e=>{
                    if(e.type !== 'call') return;

                    const from = nodePos.get(e.from);
                    const to = nodePos.get(e.to);

                    if(!from || !to) return;

                    drawCurve(svg, from, to);
                });
            }

            function drawCurve(svg, from, to){
                const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

                const dx = (to.x - from.x) / 2;

                const d = \`
                    M \${from.x + 60} \${from.y + 40}
                    C \${from.x + 60} \${from.y + 40 + dx},
                      \${to.x + 60} \${to.y - dx},
                      \${to.x + 60} \${to.y}
                \`;

                path.setAttribute("d", d);
                path.setAttribute("stroke", "#9ca3af");
                path.setAttribute("fill", "none");
                path.setAttribute("stroke-width", "2");

                svg.appendChild(path);

                // arrow head
                const arrow = document.createElementNS("http://www.w3.org/2000/svg", "polygon");

                arrow.setAttribute("points",
                    (to.x + 55) + "," + (to.y - 5) + " " +
                    (to.x + 65) + "," + (to.y - 5) + " " +
                    (to.x + 60) + "," + to.y
                );

                arrow.setAttribute("fill", "#9ca3af");

                svg.appendChild(arrow);
            }
        </script>
    </body>
    </html>
    `;
}