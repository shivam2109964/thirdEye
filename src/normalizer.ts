import type { DartParseResult } from './parser';

export type GraphNodeType = 'file' | 'class' | 'function' | 'variable';

export type GraphEdgeType = 'import' | 'contains' | 'call' | 'data';

export type GraphNode = {
    id: string;
    type: GraphNodeType;
    label: string;
    parent?: string;
    color: string;

    /** Linear position along the call flow: 0 = entry, increasing with call depth. */
    flowStep?: number;
};

export type GraphEdge = {
    id: string;
    type: GraphEdgeType;
    from: string;
    to: string;
    style: 'solid' | 'dashed' | 'dotted' | 'tree';
};

export type NormalizedGraph = {
    root?: string;
    nodes: GraphNode[];
    edges: GraphEdge[];
    // simple symbol table for downstream UI/debugging
    symbols: {
        files: string[];
        classes: string[];
        functions: string[];
        variables: string[];
    };
};

const COLORS: Record<GraphNodeType, string> = {
    file: 'orange',
    class: 'purple',
    function: 'blue',
    variable: 'green',
};

function assignLinearFlowSteps(nodes: GraphNode[], edges: GraphEdge[], root?: string): void {
    const byId = new Map(nodes.map((n) => [n.id, n] as const));

    const incomingCall = new Set<string>();
    for (const e of edges) {
        if (e.type === 'call') {
            incomingCall.add(e.to);
        }
    }

    /** Prefer a single entry: `main` (or explicit function root), then call depth is linear from there. */
    const mainEntry =
        (root && byId.get(root)?.type === 'function' ? root : undefined) ??
        nodes.find((n) => n.type === 'function' && n.label === 'main')?.id;

    let seeds: string[];
    if (mainEntry) {
        seeds = [mainEntry];
    } else {
        seeds = nodes.filter((n) => n.type === 'function' && !incomingCall.has(n.id)).map((n) => n.id);
        if (seeds.length === 0) {
            seeds = nodes.filter((n) => n.type === 'function').map((n) => n.id);
        }
    }

    const adj = new Map<string, string[]>();
    for (const e of edges) {
        if (e.type !== 'call') {
            continue;
        }
        if (!adj.has(e.from)) {
            adj.set(e.from, []);
        }
        adj.get(e.from)!.push(e.to);
    }

    const depth = new Map<string, number>();
    const queue = [...seeds];
    for (const s of seeds) {
        depth.set(s, 0);
    }

    while (queue.length) {
        const id = queue.shift()!;
        const d = depth.get(id)!;
        for (const to of adj.get(id) ?? []) {
            if (!depth.has(to)) {
                depth.set(to, d + 1);
                queue.push(to);
            }
        }
    }

    let maxD = 0;
    for (const d of depth.values()) {
        maxD = Math.max(maxD, d);
    }
    const orphanFnStep = maxD + 1;

    const stepOf = (id: string | undefined): number | undefined => {
        if (!id) {
            return undefined;
        }
        return byId.get(id)?.flowStep;
    };

    for (const n of nodes) {
        if (n.type !== 'function') {
            continue;
        }
        n.flowStep = depth.has(n.id) ? depth.get(n.id)! : orphanFnStep;
    }

    for (const n of nodes) {
        if (n.type !== 'class') {
            continue;
        }
        const methodSteps = nodes
            .filter((c) => c.parent === n.id && c.type === 'function')
            .map((c) => c.flowStep)
            .filter((s): s is number => s !== undefined);
        if (methodSteps.length) {
            n.flowStep = Math.min(...methodSteps);
        } else {
            n.flowStep = orphanFnStep;
        }
    }

    for (const n of nodes) {
        if (n.type !== 'variable' || !n.parent) {
            continue;
        }
        const ps = stepOf(n.parent);
        if (ps !== undefined) {
            n.flowStep = ps;
        } else {
            n.flowStep = orphanFnStep;
        }
    }

    for (const n of nodes) {
        if (n.type !== 'file') {
            continue;
        }
        const childSteps = nodes
            .filter((c) => c.parent === n.id)
            .map((c) => c.flowStep)
            .filter((s): s is number => s !== undefined);
        n.flowStep = childSteps.length ? Math.max(...childSteps) + 1 : 0;
    }
}

function nodeId(type: GraphNodeType, key: string) {
    return `${type}:${key}`;
}

function edgeId(type: GraphEdgeType, from: string, to: string) {
    return `${type}:${from}→${to}`;
}

export function normalizeDartParse(parse: DartParseResult): NormalizedGraph {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const addNode = (n: GraphNode) => {
        if (!nodeById.has(n.id)) {
            nodeById.set(n.id, n);
            nodes.push(n);
        }
    };

    const addEdge = (e: GraphEdge) => {
        if (!edgeById.has(e.id)) {
            edgeById.set(e.id, e);
            edges.push(e);
        }
    };

    const nodeById = new Map<string, GraphNode>();
    const edgeById = new Map<string, GraphEdge>();

    const fileNode = nodeId('file', parse.file);
    addNode({
        id: fileNode,
        type: 'file',
        label: parse.file,
        color: COLORS.file,
    });

    // imports (dependency graph)
    for (const imp of parse.imports ?? []) {
        const impFile = nodeId('file', imp);
        addNode({
            id: impFile,
            type: 'file',
            label: imp,
            color: COLORS.file,
        });
        addEdge({
            id: edgeId('import', fileNode, impFile),
            type: 'import',
            from: fileNode,
            to: impFile,
            style: 'dashed',
        });
    }

    // classes + methods (AST containment)
    const functionNameToNodeId = new Map<string, string>();
    const classMethodNames = new Map<string, Set<string>>();

    for (const cls of parse.classes ?? []) {
        const clsNode = nodeId('class', `${parse.file}:${cls.name}`);
        addNode({
            id: clsNode,
            type: 'class',
            label: cls.name,
            parent: fileNode,
            color: COLORS.class,
        });
        addEdge({
            id: edgeId('contains', fileNode, clsNode),
            type: 'contains',
            from: fileNode,
            to: clsNode,
            style: 'tree',
        });

        classMethodNames.set(cls.name, new Set(cls.methods ?? []));

        for (const m of cls.methods ?? []) {
            const fnName = `${cls.name}.${m}`;
            const fnNode = nodeId('function', `${parse.file}:${fnName}`);
            functionNameToNodeId.set(fnName, fnNode);
            addNode({
                id: fnNode,
                type: 'function',
                label: m,
                parent: clsNode,
                color: COLORS.function,
            });
            addEdge({
                id: edgeId('contains', clsNode, fnNode),
                type: 'contains',
                from: clsNode,
                to: fnNode,
                style: 'tree',
            });
        }

        for (const f of cls.fields ?? []) {
            const vNode = nodeId('variable', `${parse.file}:${cls.name}.${f}`);
            addNode({
                id: vNode,
                type: 'variable',
                label: f,
                parent: clsNode,
                color: COLORS.variable,
            });
            addEdge({
                id: edgeId('contains', clsNode, vNode),
                type: 'contains',
                from: clsNode,
                to: vNode,
                style: 'tree',
            });
        }
    }

    // top-level functions
    for (const fn of parse.functions ?? []) {
        const fnNode = nodeId('function', `${parse.file}:${fn}`);
        functionNameToNodeId.set(fn, fnNode);
        addNode({
            id: fnNode,
            type: 'function',
            label: fn,
            parent: fileNode,
            color: COLORS.function,
        });
        addEdge({
            id: edgeId('contains', fileNode, fnNode),
            type: 'contains',
            from: fileNode,
            to: fnNode,
            style: 'tree',
        });
    }

    // variables (prefer scoped info when available)
    const scopeInfo = parse.variableScopes ?? [];
    const scopedVarNames = new Set(scopeInfo.map((v) => v.name));

    const parentToNodeId = (parent: string): string => {
        // parent strings emitted by Dart:
        // - file:<file>
        // - class:<ClassName>
        // - function:<FunctionName or Class.method>
        if (parent.startsWith('file:')) return fileNode;
        if (parent.startsWith('class:')) {
            const clsName = parent.slice('class:'.length);
            return nodeId('class', `${parse.file}:${clsName}`);
        }
        if (parent.startsWith('function:')) {
            const fnName = parent.slice('function:'.length);
            const existing = functionNameToNodeId.get(fnName);
            if (existing) return existing;

            // Best-effort: if it looks like Class.method, create a placeholder.
            const placeholder = nodeId('function', `${parse.file}:${fnName}`);
            addNode({
                id: placeholder,
                type: 'function',
                label: fnName,
                parent: fileNode,
                color: COLORS.function,
            });
            functionNameToNodeId.set(fnName, placeholder);
            addEdge({
                id: edgeId('contains', fileNode, placeholder),
                type: 'contains',
                from: fileNode,
                to: placeholder,
                style: 'tree',
            });
            return placeholder;
        }
        return fileNode;
    };

    for (const v of scopeInfo) {
        const pNode = parentToNodeId(v.parent);
        const vNode = nodeId('variable', `${parse.file}:${v.parent}:${v.name}`);
        addNode({
            id: vNode,
            type: 'variable',
            label: v.name,
            parent: pNode,
            color: COLORS.variable,
        });
        addEdge({
            id: edgeId('contains', pNode, vNode),
            type: 'contains',
            from: pNode,
            to: vNode,
            style: 'tree',
        });

        // data edge: variable → function (when scoped under a function)
        if (v.parent.startsWith('function:')) {
            addEdge({
                id: edgeId('data', vNode, pNode),
                type: 'data',
                from: vNode,
                to: pNode,
                style: 'dotted',
            });
        }
    }

    // fall back: any variables without scopes attach to file
    for (const vName of parse.variables ?? []) {
        if (scopedVarNames.has(vName)) continue;
        // also skip if it's already represented as a field node by class section
        const vNode = nodeId('variable', `${parse.file}:file:${parse.file}:${vName}`);
        addNode({
            id: vNode,
            type: 'variable',
            label: vName,
            parent: fileNode,
            color: COLORS.variable,
        });
        addEdge({
            id: edgeId('contains', fileNode, vNode),
            type: 'contains',
            from: fileNode,
            to: vNode,
            style: 'tree',
        });
    }

    // calls (call graph)
    for (const c of parse.calls ?? []) {
        const fromNode = functionNameToNodeId.get(c.from) ?? nodeId('function', `${parse.file}:${c.from}`);
        if (!nodeById.has(fromNode)) {
            addNode({
                id: fromNode,
                type: 'function',
                label: c.from,
                parent: fileNode,
                color: COLORS.function,
            });
            addEdge({
                id: edgeId('contains', fileNode, fromNode),
                type: 'contains',
                from: fileNode,
                to: fromNode,
                style: 'tree',
            });
        }

        const toNode = functionNameToNodeId.get(c.to) ?? nodeId('function', `${parse.file}:${c.to}`);
        if (!nodeById.has(toNode)) {
            addNode({
                id: toNode,
                type: 'function',
                label: c.to,
                parent: fileNode,
                color: COLORS.function,
            });
            addEdge({
                id: edgeId('contains', fileNode, toNode),
                type: 'contains',
                from: fileNode,
                to: toNode,
                style: 'tree',
            });
        }

        addEdge({
            id: edgeId('call', fromNode, toNode),
            type: 'call',
            from: fromNode,
            to: toNode,
            style: 'solid',
        });
    }

    const root = parse.functions?.includes('main')
        ? functionNameToNodeId.get('main')
        : fileNode;

    assignLinearFlowSteps(nodes, edges, root);

    return {
        root,
        nodes,
        edges,
        symbols: {
            files: [...new Set(nodes.filter((n) => n.type === 'file').map((n) => n.label))],
            classes: [...new Set(nodes.filter((n) => n.type === 'class').map((n) => n.label))],
            functions: [...new Set(nodes.filter((n) => n.type === 'function').map((n) => n.label))],
            variables: [...new Set(nodes.filter((n) => n.type === 'variable').map((n) => n.label))],
        },
    };
}