import * as fs from 'fs';
const { parse } = require('java-parser');

export type JavaClass = {
    name: string;
    methods: string[];
    fields: string[];
    annotations: string[];
};

export type JavaCallSite = {
    from: string;
    to: string;
    objectName?: string;
    args?: Array<{ param: string; value: string }>;
};

export type JavaFunctionDef = {
    name: string;
    params: Array<{ name: string; type: string }>;
    annotations: string[];
};

export type ParseResult = {
    file: string;
    classes: JavaClass[];
    functions: string[];
    variables: string[];
    imports: string[];
    calls: JavaCallSite[];
    functionDefs?: JavaFunctionDef[];
    variableScopes?: Array<{ name: string; parent: string; kind: string }>;
};

// Error thrown for invalid java files
export class JavaParseUserError extends Error {
    readonly name = 'JavaParseUserError';
}

function traverse(node: any, visitors: { [key: string]: (n: any) => void }) {
    if (!node || typeof node !== 'object') return;
    
    if (node.name && visitors[node.name]) {
        visitors[node.name](node);
    }
    
    if (node.children) {
        for (const key of Object.keys(node.children)) {
            const childArray = node.children[key];
            if (Array.isArray(childArray)) {
                childArray.forEach(child => traverse(child, visitors));
            }
        }
    }
}

function extractIdentifier(node: any): string | undefined {
    if (!node) return undefined;
    if (node.children && node.children.Identifier) {
        return node.children.Identifier[0].image;
    }
    if (node.children) {
        for (const key of Object.keys(node.children)) {
            const childArray = node.children[key];
            if (Array.isArray(childArray)) {
                for (const child of childArray) {
                    const res = extractIdentifier(child);
                    if (res) return res;
                }
            }
        }
    }
    return undefined;
}

function extractAllIdentifiers(node: any): string[] {
    const ids: string[] = [];
    if (!node) return ids;
    if (node.children && node.children.Identifier) {
        for (const token of node.children.Identifier) {
            if (token.image) ids.push(token.image);
        }
    }
    if (node.children) {
        for (const key of Object.keys(node.children)) {
            const childArray = node.children[key];
            if (Array.isArray(childArray)) {
                for (const child of childArray) {
                    ids.push(...extractAllIdentifiers(child));
                }
            }
        }
    }
    return ids;
}

function extractAnnotations(node: any): string[] {
    const annotations: string[] = [];
    traverse(node, {
        annotation: (n: any) => {
            const typeName = extractIdentifier(n);
            if (typeName) {
                annotations.push(`@${typeName}`);
            }
        }
    });
    return annotations;
}

function extractCalls(node: any, callsArr: JavaCallSite[], currentMethod: string) {
    if (!node || typeof node !== 'object') return;
    
    if (node.name === 'primary') {
        const prefix = node.children?.primaryPrefix?.[0];
        const suffixes = node.children?.primarySuffix || [];
        
        const currentTargetParts: string[] = [];
        if (prefix) {
            const ids = extractAllIdentifiers(prefix);
            currentTargetParts.push(...ids);
        }
        
        for (const suffix of suffixes) {
            if (suffix.children?.methodInvocationSuffix) {
                if (currentTargetParts.length > 0) {
                    const methodName = currentTargetParts.pop() as string;
                    const objectName = currentTargetParts.join('.');
                    currentTargetParts.push(methodName + '()');
                    callsArr.push({
                        from: currentMethod,
                        to: methodName,
                        objectName: objectName || undefined,
                        args: []
                    });
                }
            } else if (suffix.children?.Identifier) {
                currentTargetParts.push(suffix.children.Identifier[0].image);
            }
        }
    }
    
    if (node.children) {
        for (const key of Object.keys(node.children)) {
            const arr = node.children[key];
            if (Array.isArray(arr)) {
                for (const child of arr) extractCalls(child, callsArr, currentMethod);
            }
        }
    }
}

export async function parseJavaFile(filePath: string): Promise<ParseResult> {
    const content = await fs.promises.readFile(filePath, 'utf-8');
    let ast: any;
    try {
        ast = parse(content);
    } catch (e: any) {
        throw new JavaParseUserError(e.message || 'Java parse failed');
    }

    const classes: JavaClass[] = [];
    const functions: string[] = [];
    const functionDefs: JavaFunctionDef[] = [];
    const variables: string[] = [];
    const imports: string[] = [];
    const calls: JavaCallSite[] = [];

    traverse(ast, {
        importDeclaration: (node: any) => {
            const ids = extractAllIdentifiers(node);
            if (ids.length) imports.push(ids.join('.'));
        },
        classDeclaration: (cNode: any) => {
            const normalClass = cNode.children?.normalClassDeclaration?.[0];
            const className = (normalClass ? extractIdentifier(normalClass) : extractIdentifier(cNode)) || 'UnknownClass';
            const clsAnnotations = extractAnnotations(cNode.children?.classModifier || cNode);
            
            const methods: string[] = [];
            const fields: string[] = [];

            traverse(cNode, {
                fieldDeclaration: (fNode: any) => {
                    const fieldName = extractIdentifier(fNode.children?.variableDeclaratorList?.[0]);
                    if (fieldName) fields.push(fieldName);
                },
                methodDeclaration: (mNode: any) => {
                    const methodName = extractIdentifier(mNode.children?.methodHeader?.[0]?.children?.methodDeclarator?.[0]);
                    if (!methodName) return;
                    methods.push(methodName);

                    const methodAnns = extractAnnotations(mNode.children?.methodModifier || mNode.children?.methodHeader?.[0]);
                    
                    const params: Array<{ name: string; type: string }> = [];
                    // Extract params roughly
                    traverse(mNode.children?.methodHeader?.[0]?.children?.methodDeclarator?.[0], {
                        formalParameter: (pNode: any) => {
                            const pName = extractIdentifier(pNode.children?.variableDeclaratorId?.[0]);
                            const pType = extractIdentifier(pNode.children?.unannType?.[0]);
                            if (pName && pType) params.push({ name: pName, type: pType });
                        }
                    });

                    functionDefs.push({
                        name: `${className}.${methodName}`,
                        params,
                        annotations: methodAnns
                    });

                    const fullMethodName = `${className}.${methodName}`;
                    functions.push(fullMethodName);

                    // Find method invocations inside this method
                    extractCalls(mNode.children?.methodBody?.[0], calls, fullMethodName);
                }
            });

            classes.push({
                name: className,
                methods,
                fields,
                annotations: clsAnnotations
            });
        }
    });

    return {
        file: filePath,
        classes,
        functions,
        functionDefs,
        variables,
        imports,
        calls
    };
}
