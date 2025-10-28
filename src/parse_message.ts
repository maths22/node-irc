import ircColors from 'irc-colors';
import replyFor from './codes';

export interface ParsedMessage {
    prefix?: string;
    nick?: string;
    user?: string;
    host?: string;
    server?: string;
    command: string;
    rawCommand?: string;
    commandType?: string;
    args: string[];
}

function isValidReply (rawCommand: string): rawCommand is keyof typeof replyFor {
    return rawCommand in replyFor;
}

/**
 * parseMessage(line, stripColors)
 *
 * takes a raw "line" from the IRC server and turns it into an object with
 * useful keys
 * @param {String} line Raw message from IRC server.
 * @param {Boolean} stripColors If true, strip IRC colors.
 * @return {Object} A parsed message object.
 */
export default function parseMessage(line: string, stripColors: boolean) {
    const message: ParsedMessage = {
        command: '',
        args: []
    };
    let match: RegExpExecArray | null;

    if (stripColors) {
        line = ircColors.stripColorsAndStyle(line);
    }

    // Parse prefix
    match = /^:([^ ]+) +/.exec(line);
    if (match) {
        message.prefix = match[1];
        line = line.replace(/^:[^ ]+ +/, '');
        match = message.prefix ? /^([_a-zA-Z0-9~[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/.exec(message.prefix) : null;
        if (match) {
            message.nick = match[1];
            message.user = match[3];
            message.host = match[4];
        }
        else {
            message.server = message.prefix;
        }
    }

    // Parse command
    match = /^([^ ]+) */.exec(line);
    if (match) {
        message.command = match[1] ?? '';
        message.rawCommand = match[1];
        message.commandType = 'normal';
        line = line.replace(/^[^ ]+ +/, '');

        if (message.rawCommand && isValidReply(message.rawCommand)) {
            const reply = replyFor[message.rawCommand];
            message.command     = reply.name;
            message.commandType = reply.type;
        }
    }

    message.args = [];
    let middle: string | undefined, trailing: string | undefined;

    // Parse parameters
    if (line.search(/^:|\s+:/) != -1) {
        match = /(.*?)(?:^:|\s+:)(.*)/.exec(line);
        if(match) {
            middle = match[1]?.trimEnd();
            trailing = match[2];
        }
    }
    else {
        middle = line;
    }

    if (middle?.length)
        message.args = middle.split(/ +/);

    if (trailing?.length)
        message.args.push(trailing);

    return message;
}
