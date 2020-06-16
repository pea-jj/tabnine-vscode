import { API_VERSION, TabNine } from "./TabNine";
import { setProgressBar } from "./progressBar";
import { handleNotification } from "./notificationsHandler";
import { ExtensionContext, commands } from "vscode";

export const CONFIG_COMMAND = 'TabNine::config';

export function registerCommands(tabNine: TabNine, context: ExtensionContext) {
    const commandHandler = async () => {
        const config = await tabNine.request(API_VERSION, {
            "Configuration": {}
        });
        setProgressBar(tabNine);
        handleNotification(tabNine);
    };
    context.subscriptions.push(commands.registerCommand(CONFIG_COMMAND, commandHandler));
}