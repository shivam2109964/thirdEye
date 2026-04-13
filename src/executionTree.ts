import type { DartCallSite, DartParseResult } from './parser';
import type { NormalizedGraph } from './normalizer';

/** Static function / method signature (definition). */
export type FunctionDef = {
    name: string;
    params: { name: string; type: string }[];
};

/**
 * One node = one invocation instance (call site), not a reusable definition.
 * Children are calls whose static caller is this callee’s name (see buildExecutionTreeView).
 */
export type FunctionCall = {
    id: string;
    functionName: string;
    args: { param: string; value: string }[];
    returnValue?: string;
    children: FunctionCall[];
};

export type ExecutionTreeViewPayload = {
    /** Preferred entry (`main` when present). */
    entry: string | null;
    root: FunctionCall | null;
    functionDefs: FunctionDef[];
    symbols: NormalizedGraph['symbols'];
};

let idSeq = 0;

function nextId(prefix: string): string {
    idSeq += 1;
    return `${prefix}_${idSeq}`;
}

function callsByCaller(calls: DartCallSite[]): Map<string, DartCallSite[]> {
    const m = new Map<string, DartCallSite[]>();
    for (const c of calls) {
        const list = m.get(c.from);
        if (list) {
            list.push(c);
        } else {
            m.set(c.from, [c]);
        }
    }
    return m;
}

function subtreeForCallee(calleeName: string, byFrom: Map<string, DartCallSite[]>): FunctionCall[] {
    const sites = byFrom.get(calleeName) ?? [];
    return sites.map((site) => ({
        id: nextId('call'),
        functionName: site.to,
        args: site.args ?? [],
        children: subtreeForCallee(site.to, byFrom),
    }));
}

function buildSymbols(parse: DartParseResult): NormalizedGraph['symbols'] {
    const calls = parse.calls ?? [];
    const fnNames = new Set<string>();
    for (const c of calls) {
        fnNames.add(c.from);
        fnNames.add(c.to);
    }
    for (const f of parse.functions ?? []) {
        fnNames.add(f);
    }
    return {
        files: [parse.file],
        classes: [...new Set((parse.classes ?? []).map((c) => c.name))].sort(),
        functions: [...fnNames].sort(),
        variables: [...(parse.variables ?? [])].sort(),
    };
}

/**
 * Builds a static execution tree: each edge in the parse is a call instance; children of a node
 * are all calls whose `from` equals that node’s callee name (source order). Multiple invocations
 * of the same callee share the same subtree shape (static analysis limitation).
 */
export function buildExecutionTreeView(parse: DartParseResult): ExecutionTreeViewPayload {
    idSeq = 0;
    const calls = parse.calls ?? [];
    const byFrom = callsByCaller(calls);

    const entry = parse.functions?.includes('main')
        ? 'main'
        : parse.functions?.length
          ? parse.functions[0]
          : null;

    const defs = parse.functionDefs ?? [];

    if (!entry) {
        return {
            entry: null,
            root: null,
            functionDefs: defs,
            symbols: buildSymbols(parse),
        };
    }

    const root: FunctionCall = {
        id: nextId('call'),
        functionName: entry,
        args: [],
        children: subtreeForCallee(entry, byFrom),
    };

    return {
        entry,
        root,
        functionDefs: defs,
        symbols: buildSymbols(parse),
    };
}
