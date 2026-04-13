import fs from 'fs';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';

export function parseFile(filePath: string) {

    const code = fs.readFileSync(filePath, 'utf-8');

    const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript']
    });

    const result = {
        functions: [] as string[],
        imports: [] as string[],
        edges: [] as { from: string; to: string }[]
    };

    let currentFunction: string | null = null;

    traverse(ast, {

        FunctionDeclaration(path) {
            if (path.node.id) {
                const name = path.node.id.name;
                result.functions.push(name);

                currentFunction = name;

                path.traverse({
                    CallExpression(innerPath) {
                        const callee = innerPath.node.callee;

                        if (callee.type === 'Identifier' && currentFunction) {
                            result.edges.push({
                                from: currentFunction,
                                to: callee.name
                            });
                        }
                    }
                });

                currentFunction = null;
            }
        },

        ImportDeclaration(path) {
            result.imports.push(path.node.source.value);
        }

    });

    return result;
}