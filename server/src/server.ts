'use strict';

import {
    IPCMessageReader, IPCMessageWriter,
    createConnection, IConnection, TextDocumentSyncKind,
    TextDocuments, ITextDocument, Diagnostic, DiagnosticSeverity,
    InitializeParams, InitializeResult, TextDocumentIdentifier,
    CompletionItem, CompletionItemKind, Files
} from 'vscode-languageserver';

import * as cp from 'child_process';

interface Settings {
    phpmd: {
        maxNumberOfProblems: number;
        enabled: boolean,
        validate: {
            executablePath: string,
            rulesets: string
        }
    }
}

const PhpmdRulesets = [
    'cleancode',
    'codesize',
    'controversial',
    'design',
    'naming',
    'unusedcode'
];

let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));
let documents: TextDocuments = new TextDocuments();
let workspaceRoot: string;
let maxNumberOfProblems: number;
let executablePath: string;
let rulesets: string;
let enabled: boolean;

let matchExpression = /([a-zA-Z_\/\.]+):(\d+)	(.*)/;
let reportFormat = 'text';

documents.listen(connection);

connection.onInitialize((params): InitializeResult => {
    workspaceRoot = params.rootPath;
    return {
        capabilities: {
            textDocumentSync: documents.syncKind,
            completionProvider: {
                resolveProvider: false
            }
        }
    }
});

documents.onDidChangeContent((change) => {
    validatePhpDocument(change.document);
});

connection.onDidChangeConfiguration((change) => {
    let settings = <Settings>change.settings;

    maxNumberOfProblems = settings.phpmd.maxNumberOfProblems || 100;
    executablePath = settings.phpmd.validate.executablePath || 'phpmd';
    enabled = settings.phpmd.enabled;

    rulesets = settings.phpmd.validate.rulesets;

    let temp = [];
    if ((rulesets || '').length > 0) {
        rulesets.split(',').forEach((elem) => {
            if (PhpmdRulesets.indexOf(elem) >= 0) {
                temp.push(elem);
            }
        });
    }
    rulesets = (temp.length > 0 ? temp : PhpmdRulesets).join(',');

    documents.all().forEach(validatePhpDocument);
});

connection.listen();

function parserResponse(line: string) {
    let matches = line.match(matchExpression);
    if (matches) {
        let line_no = parseInt(matches[2]) - 1;
        return {
            severity: DiagnosticSeverity.Error,
            range: {
                start: { line: line_no, character: 0 },
                end: { line: line_no, character: Number.MAX_VALUE }
            },
            message: "PHPMD: " + matches[3]
        };
    }
    return null;
}

function validatePhpDocument(textDocument: ITextDocument): void {

    if (!enabled) {
        return;
    }

    let response = '';
    let diagnostics: Diagnostic[] = [];

    let args = [
        Files.uriToFilePath(textDocument.uri),
        reportFormat,
        rulesets
    ];

    let exec = cp.spawn(executablePath, args);

    exec.stdout.on('data', (data: Buffer) => {

        if (maxNumberOfProblems && diagnostics.length > maxNumberOfProblems) {
            return;
        }

        response += data.toString();
        do {
            let lines = response.split("\n");
            let line = lines.shift();
            if (lines.length) {
                response = lines.join("\n");
            } else {
                response = '';
                break;
            }
            if (!line.length) {
                continue;
            }
            let error = parserResponse(line);
            if (error === null) {
                break;
            }
            diagnostics.push(error);
        } while (true);
    });

    exec.stderr.on('data', (data: Buffer) => {
        connection.console.error("phpmd: " + data.toString());
    });

    exec.on('close', (code: number) => {
        // PHPMD's command line tool currently defines three different exit codes.
        // 0, This exit code indicates that everything worked as expected. This means there was no error/exception and PHPMD hasn't detected any rule violation in the code under test.
        // 1, This exit code indicates that an error/exception occured which has interrupted PHPMD during execution.
        // 2, This exit code means that PHPMD has processed the code under test without the occurence of an error/exception, but it has detected rule violations in the analyzed source code.
        if (code > 0) {
            connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
        }
    });
}
