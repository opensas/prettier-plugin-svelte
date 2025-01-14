import { Doc, doc, FastPath, ParserOptions } from 'prettier';
import { getText } from './lib/getText';
import { snippedTagContentAttribute } from './lib/snipTagContent';
import { isBracketSameLine } from './options';
import { PrintFn } from './print';
import { isLine, removeParentheses, trimRight } from './print/doc-helpers';
import { groupConcat, printWithPrependedAttributeLine } from './print/helpers';
import {
    getAttributeTextValue,
    getLeadingComment,
    isIgnoreDirective,
    isNodeSupportedLanguage,
    isPugTemplate,
    isTypeScript,
    printRaw,
} from './print/node-helpers';
import { CommentNode, ElementNode, Node, ScriptNode, StyleNode } from './print/nodes';

const {
    builders: { concat, hardline, softline, indent, dedent, literalline },
    utils: { removeLines },
} = doc;

export function embed(
    path: FastPath,
    print: PrintFn,
    textToDoc: (text: string, options: object) => Doc,
    options: ParserOptions,
): Doc | null {
    const node: Node = path.getNode();

    if (node.isJS) {
        try {
            const embeddedOptions: any = {
                parser: expressionParser,
            };
            if (node.forceSingleQuote) {
                embeddedOptions.singleQuote = true;
            }

            let docs = textToDoc(
                forceIntoExpression(
                    // If we have snipped content, it was done wrongly and we need to unsnip it.
                    // This happens for example for {@html `<script>{foo}</script>`}
                    getText(node, options, true),
                ),
                embeddedOptions,
            );
            if (node.forceSingleLine) {
                docs = removeLines(docs);
            }
            if (node.removeParentheses) {
                docs = removeParentheses(docs);
            }
            return docs;
        } catch (e) {
            return getText(node, options, true);
        }
    }

    const embedType = (
        tag: 'script' | 'style' | 'template',
        parser: 'typescript' | 'babel-ts' | 'css' | 'pug',
        isTopLevel: boolean,
    ) =>
        embedTag(
            tag,
            options.originalText,
            path,
            (content) => formatBodyContent(content, parser, textToDoc, options),
            print,
            isTopLevel,
            options,
        );

    const embedScript = (isTopLevel: boolean) =>
        embedType(
            'script',
            // Use babel-ts as fallback because the absence does not mean the content is not TS,
            // the user could have set the default language. babel-ts will format things a little
            // bit different though, especially preserving parentheses around dot notation which
            // fixes https://github.com/sveltejs/prettier-plugin-svelte/issues/218
            isTypeScript(node) ? 'typescript' : 'babel-ts',
            isTopLevel,
        );
    const embedStyle = (isTopLevel: boolean) => embedType('style', 'css', isTopLevel);
    const embedPug = () => embedType('template', 'pug', false);

    switch (node.type) {
        case 'Script':
            return embedScript(true);
        case 'Style':
            return embedStyle(true);
        case 'Element': {
            if (node.name === 'script') {
                return embedScript(false);
            } else if (node.name === 'style') {
                return embedStyle(false);
            } else if (isPugTemplate(node)) {
                return embedPug();
            }
        }
    }

    return null;
}

function forceIntoExpression(statement: string) {
    // note the trailing newline: if the statement ends in a // comment,
    // we can't add the closing bracket right afterwards
    return `(${statement}\n)`;
}

function expressionParser(text: string, parsers: any, options: any) {
    const ast = parsers.babel(text, parsers, options);

    return { ...ast, program: ast.program.body[0].expression };
}

function preformattedBody(str: string): Doc {
    const firstNewline = /^[\t\f\r ]*\n/;
    const lastNewline = /\n[\t\f\r ]*$/;

    // If we do not start with a new line prettier might try to break the opening tag
    // to keep it together with the string. Use a literal line to skip indentation.
    return concat([literalline, str.replace(firstNewline, '').replace(lastNewline, ''), hardline]);
}

function getSnippedContent(node: Node) {
    const encodedContent = getAttributeTextValue(snippedTagContentAttribute, node);

    if (encodedContent) {
        return Buffer.from(encodedContent, 'base64').toString('utf-8');
    } else {
        return '';
    }
}

function formatBodyContent(
    content: string,
    parser: 'typescript' | 'babel-ts' | 'css' | 'pug',
    textToDoc: (text: string, options: object) => Doc,
    options: ParserOptions & { pugTabWidth?: number },
) {
    try {
        const body = textToDoc(content, { parser });

        if (parser === 'pug' && typeof body === 'string') {
            // Pug returns no docs but a final string.
            // Therefore prepend the line offsets
            const whitespace = options.useTabs
                ? '\t'
                : ' '.repeat(
                      options.pugTabWidth && options.pugTabWidth > 0
                          ? options.pugTabWidth
                          : options.tabWidth,
                  );
            const pugBody = body
                .split('\n')
                .map((line) => (line ? whitespace + line : line))
                .join('\n');
            return concat([hardline, pugBody]);
        }

        const indentIfDesired = (doc: Doc) =>
            options.svelteIndentScriptAndStyle ? indent(doc) : doc;
        trimRight([body], isLine);
        return concat([indentIfDesired(concat([hardline, body])), hardline]);
    } catch (error) {
        if (process.env.PRETTIER_DEBUG) {
            throw error;
        }

        // We will wind up here if there is a syntax error in the embedded code. If we throw an error,
        // prettier will try to print the node with the printer. That will fail with a hard-to-interpret
        // error message (e.g. "Unsupported node type", referring to `<script>`).
        // Therefore, fall back on just returning the unformatted text.
        console.error(error);

        return preformattedBody(content);
    }
}

function embedTag(
    tag: 'script' | 'style' | 'template',
    text: string,
    path: FastPath,
    formatBodyContent: (content: string) => Doc,
    print: PrintFn,
    isTopLevel: boolean,
    options: ParserOptions,
) {
    const node: ScriptNode | StyleNode | ElementNode = path.getNode();
    const content =
        tag === 'template' ? printRaw(node as ElementNode, text) : getSnippedContent(node);
    const previousComments =
        node.type === 'Script' || node.type === 'Style'
            ? node.comments
            : [getLeadingComment(path)]
                  .filter(Boolean)
                  .map((comment) => ({ comment: comment as CommentNode, emptyLineAfter: false }));

    const canFormat =
        isNodeSupportedLanguage(node) &&
        !isIgnoreDirective(previousComments[previousComments.length - 1]?.comment) &&
        (tag !== 'template' ||
            options.plugins.some(
                (plugin) => typeof plugin !== 'string' && plugin.parsers && plugin.parsers.pug,
            ));
    const body: Doc = canFormat
        ? content.trim() !== ''
            ? formatBodyContent(content)
            : content === ''
            ? ''
            : hardline
        : preformattedBody(content);

    const openingTag = groupConcat([
        '<',
        tag,
        indent(
            groupConcat([
                ...path.map(printWithPrependedAttributeLine(node, options, print), 'attributes'),
                isBracketSameLine(options) ? '' : dedent(softline),
            ]),
        ),
        '>',
    ]);
    let result = groupConcat([openingTag, body, '</', tag, '>']);

    const comments = [];
    for (const comment of previousComments) {
        comments.push('<!--', comment.comment.data, '-->');
        comments.push(hardline);
        if (comment.emptyLineAfter) {
            comments.push(hardline);
        }
    }

    if (isTopLevel && options.svelteSortOrder !== 'none') {
        // top level embedded nodes have been moved from their normal position in the
        // node tree. if there is a comment referring to it, it must be recreated at
        // the new position.
        return concat([...comments, result, hardline]);
    } else {
        return comments.length ? concat([...comments, result]) : result;
    }
}
