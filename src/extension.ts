/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

'use strict';

import * as vscode from 'vscode';
import { TabNine } from './TabNine';
import {COMPLETION_IMPORTS, importsHandler} from './importsHandler';
import * as fs from 'fs';
import * as path from 'path';
import { getContext } from './extensionContext';
import { TabNineExtensionContext } from "./TabNineExtensionContext";
import { EOL } from 'os';

const CHAR_LIMIT = 100000;
const MAX_NUM_RESULTS = 5;

export function activate(context: vscode.ExtensionContext) {
  const tabNineExtensionContext =  getContext();
  let lastUserMessage = "";

  handleAutoImports(tabNineExtensionContext, context);
  handleUninstall(tabNineExtensionContext);  

  const command = 'TabNine::config';
  const commandHandler = () => {
    const request = tabNine.request("1.0.7", {
      "Configuration": {}
    });
  };
  context.subscriptions.push(vscode.commands.registerCommand(command, commandHandler));

  const tabNine = new TabNine(tabNineExtensionContext);

  const triggers = [
    ' ',
    '.',
    '(',
    ')',
    '{',
    '}',
    '[',
    ']',
    ',',
    ':',
    '\'',
    '"',
    '=',
    '<',
    '>',
    '/',
    '\\',
    '+',
    '-',
    '|',
    '&',
    '*',
    '%',
    '=',
    '$',
    '#',
    '@',
    '!',
  ];

  vscode.languages.registerCompletionItemProvider({ pattern: '**' }, {
    async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
      try {
        const offset = document.offsetAt(position);
        const before_start_offset = Math.max(0, offset - CHAR_LIMIT)
        const after_end_offset = offset + CHAR_LIMIT;
        const before_start = document.positionAt(before_start_offset);
        const after_end = document.positionAt(after_end_offset);
        const before = document.getText(new vscode.Range(before_start, position));
        const after = document.getText(new vscode.Range(position, after_end));
        const request = tabNine.request("1.0.7", {
          "Autocomplete": {
            "filename": document.fileName,
            "before": before,
            "after": after,
            "region_includes_beginning": (before_start_offset === 0),
            "region_includes_end": (document.offsetAt(after_end) !== after_end_offset),
            "max_num_results": MAX_NUM_RESULTS,
          }
        });
        if (!completionIsAllowed(document, position)) {
          return undefined;
        }
        const response: AutocompleteResult = await request;
        let completionList;
        if (response.results.length === 0) {
          completionList = [];
        } else {
          const results = [];
          
          let detailMessage = response.user_message.join(EOL);
          if (lastUserMessage.localeCompare(detailMessage)){
            vscode.window.showInformationMessage(detailMessage);
            lastUserMessage = detailMessage;
          }

          let limit = undefined;
          if (showFew(response, document, position)) {
            limit = 1;
          }
          let index = 0;
          for (const entry of response.results) {
            results.push(makeCompletionItem({
              document,
              index,
              position,
              old_prefix: response.old_prefix,
              entry,
            }));
            index += 1;
            if (limit !== undefined && index >= limit) {
              break;
            }
          }
          completionList = results;
        }
        return new vscode.CompletionList(completionList, true);
      } catch (e) {
        console.log(`Error setting up request: ${e}`);
      }
    }
  }, ...triggers);

  function showFew(response: AutocompleteResult, document: vscode.TextDocument, position: vscode.Position): boolean {
    for (const entry of response.results) {
      if (entry.kind || entry.documentation) {
        return false;
      }
    }
    const leftPoint = position.translate(0, -response.old_prefix.length);
    const tail = document.getText(new vscode.Range(document.lineAt(leftPoint).range.start, leftPoint));
    return tail.endsWith('.') || tail.endsWith('::');
  }

  function makeCompletionItem(args: {
    document: vscode.TextDocument,
    index: number,
    position: vscode.Position,
    old_prefix: string,
    entry: ResultEntry,
  })
    : vscode.CompletionItem
  {
    let item = new vscode.CompletionItem(args.entry.new_prefix);
    item.sortText = new Array(args.index + 2).join("0");
    item.insertText = new vscode.SnippetString(escapeTabStopSign(args.entry.new_prefix));
    if (tabNineExtensionContext.isTabNineAutoImportEnabled){
      item.command = {
        arguments: [{ completion: args.entry.new_prefix}],
        command: COMPLETION_IMPORTS,
        title: "accept completion",
      };
    }
    if (args.entry.new_suffix) {
      item.insertText
        .appendTabstop(0)
        .appendText(escapeTabStopSign(args.entry.new_suffix));
    }
    

    item.range = new vscode.Range(args.position.translate(0, -args.old_prefix.length), args.position.translate(0, args.entry.old_suffix.length));
    if (args.entry.documentation) {
      item.documentation = formatDocumentation(args.entry.documentation);
    }
    item.detail = args.entry.detail;
    item.preselect = (args.index === 0);
    item.kind = args.entry.kind;
    return item;
  }

  function formatDocumentation(documentation: string | MarkdownStringSpec): string | vscode.MarkdownString {
    if (isMarkdownStringSpec(documentation)) {
      if (documentation.kind == "markdown") {
        return new vscode.MarkdownString(documentation.value);
      } else {
        return documentation.value;
      }
    } else {
      return documentation;
    }
  }
  function escapeTabStopSign(value){
    return value.replace(new RegExp("\\$", 'g'), "\\$");
  }

  function isMarkdownStringSpec(x: any): x is MarkdownStringSpec {
    return x.kind;
  }

  function completionIsAllowed(document: vscode.TextDocument, position: vscode.Position): boolean {
    const configuration = vscode.workspace.getConfiguration();
    let disable_line_regex = configuration.get<string[]>('tabnine.disable_line_regex');
    if (disable_line_regex === undefined) {
      disable_line_regex = [];
    }
    let line = undefined;
    for (const r of disable_line_regex) {
      if (line === undefined) {
        line = document.getText(new vscode.Range(
          position.with({character: 0}),
          position.with({character: 500}),
        ))
      }
      if (new RegExp(r).test(line)) {
        return false;
      }
    }
    let disable_file_regex = configuration.get<string[]>('tabnine.disable_file_regex');
    if (disable_file_regex === undefined) {
      disable_file_regex = []
    }
    for (const r of disable_file_regex) {
      if (new RegExp(r).test(document.fileName)) {
        return false;
      }
    }
    return true;
  }
}

interface AutocompleteResult {
  old_prefix: string,
  results: ResultEntry[],
  user_message: string[],
}

interface ResultEntry {
  new_prefix: string,
  old_suffix: string,
  new_suffix: string,

  kind?: vscode.CompletionItemKind,
  detail?: string,
  documentation?: string | MarkdownStringSpec,
  deprecated?: boolean
}

interface MarkdownStringSpec {
  kind: string,
  value: string
}


function handleAutoImports(tabNineExtensionContext: TabNineExtensionContext, context: vscode.ExtensionContext) {
  if (tabNineExtensionContext.isTabNineAutoImportEnabled) {
    context.subscriptions.push(vscode.commands.registerTextEditorCommand(COMPLETION_IMPORTS, importsHandler));
  }
}

function handleUninstall(context: TabNineExtensionContext) {
  try {
    const extensionsPath = path.dirname(context.extensionPath);
    const uninstalledPath = path.join(extensionsPath, '.obsolete');
    const isFileExists = (curr: fs.Stats, prev: fs.Stats) => curr.size != 0;
    const isModified = (curr: fs.Stats, prev: fs.Stats) => new Date(curr.mtimeMs) >= new Date(prev.atimeMs);
    const isUpdating = (files) => files.filter(f => f.toLowerCase().includes(context.id.toLowerCase())).length != 1; 
    const watchFileHandler = (curr: fs.Stats, prev: fs.Stats) => {
      if (isFileExists(curr, prev) && isModified(curr, prev)) {
        fs.readFile(uninstalledPath, (err, uninstalled) => {
          try {
            if (err) {
              console.error("failed to read .obsolete file:", err);
              throw err;
            }
            fs.readdir(extensionsPath, async (err, files) => {
              if (err) {
                console.error(`failed to read ${extensionsPath} directory:`, err);
                throw err;
              }
              if (!isUpdating(files) && uninstalled.includes(context.name)){
                await TabNine.reportUninstalling(context);
                fs.unwatchFile(uninstalledPath, watchFileHandler);
              }
            });
          } catch (error) {
            console.error("failed to report uninstall:", error);
          }
        })
      }
    }
    fs.watchFile(uninstalledPath, watchFileHandler);
  } catch (error) {
    console.error("failed to invoke uninstall:", error);
  }
}

