/*
    irc.js - Node JS IRC client library

    (C) Copyright Martyn Smith 2010

    This library is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This library is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this library.  If not, see <http://www.gnu.org/licenses/>.
*/

// There's enough uses of this that are not worth trying to clean up now
/* eslint-disable @typescript-eslint/no-dynamic-delete */


import net, { NetConnectOpts, Socket } from 'node:net'
import tls, { ConnectionOptions, TLSSocket } from 'node:tls'
import { EventEmitter } from 'node:events';
import { ParsedMessage } from './parse_message';
import * as colors from './colors';
import parseMessage from './parse_message';
import CyclingPingTimer from './cycling_ping_timer'
import debugBuilder from 'debug';
const debug = debugBuilder('irc:debug');
const errorLog = debugBuilder('irc:error');

export { colors }

const lineDelimiter = new RegExp('\\r\\n|\\r|\\n')

interface IRCClientOptions {
    server: string;
    nick: string;
    password: string | null;
    userName: string;
    realName: string;
    port: number;
    localAddress: string | null;
    autoRejoin: boolean;
    autoConnect: boolean;
    channels: string[];
    retryCount: number | null;
    retryDelay: number;
    secure: boolean | Partial<ConnectionOptions>;
    selfSigned: boolean;
    certExpired: boolean;
    floodProtection: boolean;
    floodProtectionDelay: number;
    sasl: boolean;
    stripColors: boolean;
    channelPrefixes: string;
    messageSplit: number;
    encoding: string | false;
    webirc: {
        pass: string;
        ip: string;
        host: string;
    };
    millisecondsOfSilenceBeforePingSent: number;
    millisecondsBeforePingTimeout: number;
    nickMod?: number;
}

interface ServerSupportedFeatures {
    channel: {
        idlength: Record<string, number>;
        length: number;
        limit: Record<string, number>;
        modes: { a: string; b: string; c: string; d: string; };
        types: string;
    };
    kicklength: number;
    maxlist: Record<string, number>;
    maxtargets: Record<string, number>;
    modes: number;
    nicklength: number;
    topiclength: number;
    usermodes: string;
}

interface ChannelData {
    key: string;
    serverName: string;
    users: Record<string, string>;
    modeParams: Record<string, string[]>;
    mode: string;
    created?: string;
    topic?: string;
    topicBy?: string;
}

interface WhoisData {
    nick: string;
    user?: string;
    host?: string;
    realname?: string;
    idle?: string;
    channels?: string[];
    server?: string;
    serverinfo?: string;
    operator?: string;
    account?: string;
    accountinfo?: string;
    away?: string;
}

function copyValue<T>(source: T, target: T, key: keyof T) {
    target[key] = source[key];
}

// TODO eventemitter types
export class Client extends EventEmitter {
    conn: Socket & {
        connected?: boolean;
        requestedDisconnect?: boolean;
        cyclingPingTimer?: CyclingPingTimer;
    }| null = null;
    prefixForMode: Record<string, string> = {};
    modeForPrefix: Record<string, string> = {};
    chans: Record<string, ChannelData> = {};
    _whoisData: Record<string, WhoisData> = {};
    hostMask = '';
    opt: IRCClientOptions;
    supported: ServerSupportedFeatures;
    pingCounter = 1;
    nick = '';
    motd = '';
    maxLineLength = 0;
    // Temporary working list of channels during a LIST command
    channellist: { name: string; users: string; topic: string }[] = [];

    constructor(server: string, nick: string, opt?: Partial<IRCClientOptions>) {
        super();
        this.opt = {
            server: server,
            nick: nick,
            password: null,
            userName: 'nodebot',
            realName: 'nodeJS IRC client',
            port: 6667,
            localAddress: null,
            autoRejoin: false,
            autoConnect: true,
            channels: [],
            retryCount: null,
            retryDelay: 2000,
            secure: false,
            selfSigned: false,
            certExpired: false,
            floodProtection: false,
            floodProtectionDelay: 1000,
            sasl: false,
            stripColors: false,
            channelPrefixes: '&#',
            messageSplit: 512,
            encoding: false,
            webirc: {
                pass: '',
                ip: '',
                host: ''
            },
            millisecondsOfSilenceBeforePingSent: 15 * 1000,
            millisecondsBeforePingTimeout: 8 * 1000
        };

        // Features supported by the server
        // (initial values are RFC 1459 defaults. Zeros signify
        // no default or unlimited value)
        this.supported = {
            channel: {
                idlength: {},
                length: 200,
                limit: {},
                modes: { a: '', b: '', c: '', d: ''},
                types: this.opt.channelPrefixes
            },
            kicklength: 0,
            maxlist: {},
            maxtargets: {},
            modes: 3,
            nicklength: 9,
            topiclength: 0,
            usermodes: ''
        };

        if (opt) {
            for (const key of Object.keys(this.opt) as (keyof IRCClientOptions)[]) {
                if (opt[key] !== undefined) {
                    copyValue(opt, this.opt, key);
                }
            }
        }

        if (this.opt.floodProtection) {
            this.activateFloodProtection();
        }


        // TODO - fail if nick or server missing
        // TODO - fail if username has a space in it
        if (this.opt.autoConnect) {
            this.connect();
        }

        this.addListener('raw', (message: ParsedMessage) => {
            switch (message.command) {
                case 'rpl_welcome': {
                    // Set nick to whatever the server decided it really is
                    // (normally this is because you chose something too long and
                    // the server has shortened it
                    this.nick = message.args[0] ?? '';
                    // Note our hostmask to use it in splitting long messages.
                    // We don't send our hostmask when issuing PRIVMSGs or NOTICEs,
                    // of course, but rather the servers on the other side will
                    // include it in messages and will truncate what we send if
                    // the string is too long. Therefore, we need to be considerate
                    // neighbors and truncate our messages accordingly.
                    const welcomeStringWords = message.args[1]?.split(/\s+/) ?? [];
                    this.hostMask = welcomeStringWords[welcomeStringWords.length - 1] ?? '';
                    this._updateMaxLineLength();
                    this.emit('registered', message);
                    this.whois(this.nick, (args) => {
                        this.nick = args.nick;
                        this.hostMask = (args.user ?? '')+ '@' + (args.host ?? '');
                        this._updateMaxLineLength();
                    });
                    break;
                }
                case 'rpl_myinfo':
                    this.supported.usermodes = message.args[3] ?? '';
                    break;
                case 'rpl_isupport':
                    message.args.forEach((arg) => {
                        let match;
                        match = /([A-Z]+)=(.*)/.exec(arg);
                        if (match) {
                            const param = match[1];
                            const value = match[2] ?? '';
                            switch (param) {
                                case 'CHANLIMIT':
                                    value.split(',').forEach((val) => {
                                        const [k, v] = val.split(':');
                                        this.supported.channel.limit[k ?? ''] = parseInt(v ?? '');
                                    });
                                    break;
                                case 'CHANMODES': {
                                    const values = value.split(',');
                                    const type = ['a', 'b', 'c', 'd'] as const;
                                    for (let i = 0; i < type.length; i++) {
                                        this.supported.channel.modes[type[i] ?? 'a'] += values[i] ?? '';
                                    }
                                    break;
                                }
                                case 'CHANTYPES':
                                    this.supported.channel.types = value;
                                    break;
                                case 'CHANNELLEN':
                                    this.supported.channel.length = parseInt(value);
                                    break;
                                case 'IDCHAN':
                                    value.split(',').forEach((val) => {
                                        const [k, v] = val.split(':');
                                        this.supported.channel.idlength[k ?? ''] = parseInt(v ?? '');
                                    });
                                    break;
                                case 'KICKLEN':
                                    this.supported.kicklength = parseInt(value);
                                    break;
                                case 'MAXLIST':
                                    value.split(',').forEach((val) => {
                                        const [k, v] = val.split(':');
                                        this.supported.maxlist[k ?? ''] = parseInt(v ?? '');
                                    });
                                    break;
                                case 'NICKLEN':
                                    this.supported.nicklength = parseInt(value);
                                    break;
                                case 'PREFIX':
                                    match = /\((.*?)\)(.*)/.exec(value);
                                    if (match?.[1] && match[2]) {
                                        const modes = match[1].split('');
                                        const prefixes = match[2].split('');
                                        while (modes.length) {
                                            this.modeForPrefix[prefixes[0] ?? ''] = modes[0] ?? '';
                                            this.supported.channel.modes.b += modes[0] ?? '';
                                            this.prefixForMode[modes.shift() ?? ''] = prefixes.shift() ?? '';
                                        }
                                    }
                                    break;
                                case 'STATUSMSG':
                                    break;
                                case 'TARGMAX':
                                    value.split(',').forEach((val) => {
                                        const [k, v] = val.split(':');
                                        const num = (!v) ? 0 : parseInt(v);
                                        this.supported.maxtargets[k ?? ''] = num;
                                    });
                                    break;
                                case 'TOPICLEN':
                                    this.supported.topiclength = parseInt(value);
                                    break;
                            }
                        }
                    });
                    break;
                case 'rpl_yourhost':
                case 'rpl_created':
                case 'rpl_luserclient':
                case 'rpl_luserop':
                case 'rpl_luserchannels':
                case 'rpl_luserme':
                case 'rpl_localusers':
                case 'rpl_globalusers':
                case 'rpl_statsconn':
                case 'rpl_luserunknown':
                case '396':
                case '042':
                    // Random welcome crap, ignoring
                    break;
                case 'err_nicknameinuse':
                    if (typeof (this.opt.nickMod) == 'undefined')
                        this.opt.nickMod = 0;
                    this.opt.nickMod++;
                    this.send('NICK', this.opt.nick + this.opt.nickMod.toString());
                    this.nick = this.opt.nick + this.opt.nickMod.toString();
                    this._updateMaxLineLength();
                    break;
                case 'PING':
                    this.send('PONG', message.args[0] ?? '');
                    this.emit('ping', message.args[0]);
                    break;
                case 'PONG':
                    this.emit('pong', message.args[0]);
                    break;
                case 'NOTICE': {
                    const from = message.nick ?? '';
                    let to: string | null = message.args[0] ?? '';
                    if (!to) {
                        to = null;
                    }
                    const text = message.args[1] ?? '';
                    if (text.startsWith('\u0001') && text.lastIndexOf('\u0001') > 0) {
                        this._handleCTCP(from, to ?? '', text, 'notice', message);
                        break;
                    }
                    this.emit('notice', from, to, text, message);

                    if (to == this.nick)
                        debug('GOT NOTICE from ' + (from ? '"' + from + '"' : 'the server') + ': "' + text + '"');
                    break;
                }
                case 'MODE': {
                    debug('MODE: %o sets mode: %o', message.args[0], message.args[1]);

                    const channel = this.chanData(message.args[0] ?? '');
                    if (!channel) break;
                    const modeList = (message.args[1] ?? '').split('');
                    let adding = true;
                    const modeArgs = message.args.slice(2);
                    modeList.forEach((mode) => {
                        if (mode == '+') {
                            adding = true;
                            return;
                        }
                        if (mode == '-') {
                            adding = false;
                            return;
                        }

                        const eventName = (adding ? '+' : '-') + 'mode';
                        const supported = this.supported.channel.modes;
                        let modeArg: string | undefined;
                        const chanModes = (mode: string, param?: string | string[]) => {
                            const arr = param && Array.isArray(param);
                            if (adding) {
                                if (!channel.mode.includes(mode)) {
                                    channel.mode += mode;
                                }
                                if (param === undefined) {
                                    channel.modeParams[mode] = [];
                                } else if (arr) {
                                    channel.modeParams[mode] = channel.modeParams[mode] ?
                                        channel.modeParams[mode].concat(param) : param;
                                } else {
                                    channel.modeParams[mode] = [param];
                                }
                            } else {
                                if (arr) {
                                    channel.modeParams[mode] = channel.modeParams[mode]
                                        ?.filter(function(v) { return v !== param[0]; }) ?? [];
                                }
                                if (!arr || channel.modeParams[mode]?.length === 0) {
                                    channel.mode = channel.mode.replace(mode, '');
                                    delete channel.modeParams[mode];
                                }
                            }
                        };
                        if (mode in this.prefixForMode) {
                            modeArg = modeArgs.shift() ?? '';
                            if (Object.prototype.hasOwnProperty.call(channel.users, modeArg)) {
                                if (adding) {
                                    const usersForMode = channel.users[modeArg];
                                    if (usersForMode && !usersForMode.includes(this.prefixForMode[mode] ?? ''))
                                        channel.users[modeArg] = (channel.users[modeArg] ?? '') + (this.prefixForMode[mode] ?? '');
                                } else channel.users[modeArg] = (channel.users[modeArg] ?? '').replace(this.prefixForMode[mode] ?? '', '');
                            }
                            this.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
                        } else if (supported.a.includes(mode)) {
                            modeArg = modeArgs.shift();
                            chanModes(mode, [modeArg ?? '']);
                            this.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
                        } else if (supported.b.includes(mode)) {
                            modeArg = modeArgs.shift();
                            chanModes(mode, modeArg);
                            this.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
                        } else if (supported.c.includes(mode)) {
                            if (adding) modeArg = modeArgs.shift();
                            else modeArg = undefined;
                            chanModes(mode, modeArg);
                            this.emit(eventName, message.args[0], message.nick, mode, modeArg, message);
                        } else if (supported.d.includes(mode)) {
                            chanModes(mode);
                            this.emit(eventName, message.args[0], message.nick, mode, undefined, message);
                        }
                    });
                    break;
                }
                case 'NICK': {
                    if (message.nick == this.nick) {
                        // the user just changed their own nick
                        this.nick = message.args[0] ?? '';
                        this._updateMaxLineLength();
                    }

                    debug('NICK: %o changes nick to %o', message.nick, message.args[0]);
                    const channels = [];

                    // TODO better way of finding what channels a user is in?
                    for (const channame in this.chans) {
                        const channel = this.chans[channame];
                        if(channel) {
                            channel.users[message.args[0] ?? ''] = channel.users[message.nick ?? ''] ?? '';
                            delete channel.users[message.nick ?? ''];
                        }
                        channels.push(channame);
                    }

                    // old nick, new nick, channels
                    this.emit('nick', message.nick, message.args[0], channels, message);
                    break;
                }
                case 'rpl_motdstart':
                    this.motd = (message.args[1] ?? '') + '\n';
                    break;
                case 'rpl_motd':
                    this.motd += (message.args[1] ?? '') + '\n';
                    break;
                case 'rpl_endofmotd':
                case 'err_nomotd':
                    this.motd += (message.args[1] ?? '') + '\n';
                    this.emit('motd', this.motd);
                    break;
                case 'rpl_namreply': {
                    const channel = this.chanData(message.args[2] ?? '');
                    const users = message.args[3]?.trim().split(/ +/);
                    if (channel && users) {
                        users.forEach((user) => {
                            const match = /^(.)(.*)$/.exec(user);
                            if (match) {
                                if ((match[1] ?? '') in this.modeForPrefix) {
                                    channel.users[(match[2] ?? '')] = match[1] ?? '';
                                }
                                else {
                                    channel.users[(match[1] ?? '') + (match[2] ?? '')] = '';
                                }
                            }
                        });
                    }
                    break;
                }
                case 'rpl_endofnames': {
                    const channel = this.chanData(message.args[1] ?? '');
                    if (channel) {
                        this.emit('names', message.args[1], channel.users);
                        this.emit('names' + (message.args[1] ?? ''), channel.users);
                        this.send('MODE', message.args[1] ?? '');
                    }
                    break;
                }
                case 'rpl_topic': {
                    const channel = this.chanData(message.args[1] ?? '');
                    if (channel) {
                        channel.topic = message.args[2];
                    }
                    break;
                }
                case 'rpl_away':
                    this._addWhoisData(message.args[1] ?? '', 'away', message.args[2], true);
                    break;
                case 'rpl_whoisuser':
                    this._addWhoisData(message.args[1] ?? '', 'user', message.args[2]);
                    this._addWhoisData(message.args[1] ?? '', 'host', message.args[3]);
                    this._addWhoisData(message.args[1] ?? '', 'realname', message.args[5]);
                    break;
                case 'rpl_whoisidle':
                    this._addWhoisData(message.args[1] ?? '', 'idle', message.args[2]);
                    break;
                case 'rpl_whoischannels':
                // TODO - clean this up?
                    this._addWhoisData(message.args[1] ?? '', 'channels', message.args[2]?.trim().split(/\s+/));
                    break;
                case 'rpl_whoisserver':
                    this._addWhoisData(message.args[1] ?? '', 'server', message.args[2]);
                    this._addWhoisData(message.args[1] ?? '', 'serverinfo', message.args[3]);
                    break;
                case 'rpl_whoisoperator':
                    this._addWhoisData(message.args[1] ?? '', 'operator', message.args[2]);
                    break;
                case '330': // rpl_whoisaccount?
                    this._addWhoisData(message.args[1] ?? '', 'account', message.args[2]);
                    this._addWhoisData(message.args[1] ?? '', 'accountinfo', message.args[3]);
                    break;
                case 'rpl_endofwhois':
                    this.emit('whois', this._clearWhoisData(message.args[1] ?? ''));
                    break;
                case 'rpl_whoreply':
                    this._addWhoisData(message.args[5] ?? '', 'user', message.args[2]);
                    this._addWhoisData(message.args[5] ?? '', 'host', message.args[3]);
                    this._addWhoisData(message.args[5] ?? '', 'server', message.args[4]);
                    this._addWhoisData(message.args[5] ?? '', 'realname', /[0-9]+\s*(.+)/g.exec(message.args[7] ?? '')?.[1] ?? '');
                    // emit right away because rpl_endofwho doesn't contain nick
                    this.emit('whois', this._clearWhoisData(message.args[5] ?? ''));
                    break;
                case 'rpl_liststart':
                    this.channellist = [];
                    this.emit('channellist_start');
                    break;
                case 'rpl_list': {
                    const channel = {
                        name: message.args[1] ?? '',
                        users: message.args[2] ?? '',
                        topic: message.args[3] ?? ''
                    };
                    this.emit('channellist_item', channel);
                    this.channellist.push(channel);
                    break;
                }
                case 'rpl_listend':
                    this.emit('channellist', this.channellist);
                    break;
                case 'rpl_topicwhotime': {
                    const channel = this.chanData(message.args[1] ?? '');
                    if (channel) {
                        channel.topicBy = message.args[2];
                        // channel, topic, nick
                        this.emit('topic', message.args[1], channel.topic, channel.topicBy, message);
                    }
                    break;
                }
                case 'TOPIC': {
                    // channel, topic, nick
                    this.emit('topic', message.args[0], message.args[1], message.nick, message);

                    const channel = this.chanData(message.args[0] ?? '');
                    if (channel) {
                        channel.topic = message.args[1];
                        channel.topicBy = message.nick;
                    }
                    break;
                }
                case 'rpl_channelmodeis': {
                    const channel = this.chanData(message.args[1] ?? '');
                    if (channel) {
                        channel.mode = message.args[2] ?? '';
                    }
                    break;
                }
                case 'rpl_creationtime': {
                    const channel = this.chanData(message.args[1] ?? '');
                    if (channel) {
                        channel.created = message.args[2];
                    }
                    break;
                }
                case 'JOIN':
                    // channel, who
                    if (this.nick == message.nick) {
                        this.chanData(message.args[0] ?? '', true);
                    }
                    else {
                        const channel = this.chanData(message.args[0] ?? '');
                        if (channel?.users) {
                            channel.users[message.nick ?? ''] = '';
                        }
                    }
                    this.emit('join', message.args[0], message.nick, message);
                    this.emit('join' + (message.args[0] ?? ''), message.nick, message);
                    if (message.args[0] != message.args[0]?.toLowerCase()) {
                        this.emit('join' + (message.args[0] ?? '').toLowerCase(), message.nick, message);
                    }
                    break;
                case 'PART':
                    // channel, who, reason
                    this.emit('part', message.args[0], message.nick, message.args[1], message);
                    this.emit('part' + (message.args[0] ?? ''), message.nick, message.args[1], message);
                    if (message.args[0] != message.args[0]?.toLowerCase()) {
                        this.emit('part' + (message.args[0] ?? '').toLowerCase(), message.nick, message.args[1], message);
                    }
                    if (this.nick == message.nick) {
                        const channel = this.chanData(message.args[0] ?? '');
                        delete this.chans[channel?.key ?? ''];
                    }
                    else {
                        const channel = this.chanData(message.args[0] ?? '');
                        if (channel?.users) {
                            delete channel.users[message.nick ?? ''];
                        }
                    }
                    break;
                case 'KICK':
                    // channel, who, by, reason
                    this.emit('kick', message.args[0], message.args[1], message.nick, message.args[2], message);
                    this.emit('kick' + (message.args[0] ?? ''), message.args[1], message.nick, message.args[2], message);
                    if (message.args[0] != message.args[0]?.toLowerCase()) {
                        this.emit('kick' + (message.args[0] ?? '').toLowerCase(),
                                message.args[1], message.nick, message.args[2], message);
                    }

                    if (this.nick == message.args[1]) {
                        const channel = this.chanData(message.args[0] ?? '');
                        delete this.chans[channel?.key ?? ''];
                    }
                    else {
                        const channel = this.chanData(message.args[0] ?? '');
                        if (channel?.users) {
                            delete channel.users[message.args[1] ?? ''];
                        }
                    }
                    break;
                case 'KILL': {
                    const nick = message.args[0];
                    const channels: string[] = [];
                    Object.keys(this.chans).forEach((channame) => {
                        const channel = this.chans[channame];
                        channels.push(channame);
                        delete channel?.users[nick ?? ''];
                    });
                    this.emit('kill', nick, message.args[1], channels, message);
                    break;
                }
                case 'PRIVMSG': {
                    const from = message.nick ?? '';
                    const to = message.args[0] ?? '';
                    const text = message.args[1] ?? '';
                    if (text.startsWith('\u0001') && text.lastIndexOf('\u0001') > 0) {
                        this._handleCTCP(from, to, text, 'privmsg', message);
                        break;
                    }
                    this.emit('message', from, to, text, message);
                    if (this.supported.channel.types.includes(to.charAt(0))) {
                        this.emit('message#', from, to, text, message);
                        this.emit('message' + to, from, text, message);
                        if (to != to.toLowerCase()) {
                            this.emit('message' + to.toLowerCase(), from, text, message);
                        }
                    }
                    if (to.toUpperCase() === this.nick.toUpperCase()) this.emit('pm', from, text, message);

                    if (to == this.nick)
                        debug('GOT MESSAGE from %s: %o', from, text);
                    break;
                }
                case 'INVITE': {
                    const from = message.nick;
                    const channel = message.args[1];
                    this.emit('invite', channel, from, message);
                    break;
                }
                case 'QUIT': {
                    debug('QUIT: %o %o', message.prefix, message.args);
                    if (this.nick == message.nick) {
                        // TODO handle?
                        break;
                    }
                    // handle other people quitting

                    const channels: string[] = [];

                    // TODO better way of finding what channels a user is in?
                    Object.keys(this.chans).forEach((channame) => {
                        const channel = this.chans[channame];
                        if(channel) {
                            delete channel.users[message.nick ?? ''];
                        }
                        channels.push(channame);
                    });

                    // who, reason, channels
                    this.emit('quit', message.nick, message.args[0], channels, message);
                    break;
                }

                // for sasl
                case 'CAP':
                    if (message.args[0] === '*' &&
                        message.args[1] === 'ACK' &&
                        message.args[2]?.startsWith('sasl')) // there can be a space after sasl
                        this.send('AUTHENTICATE', 'PLAIN');
                    break;
                case 'AUTHENTICATE':
                    if (message.args[0] === '+') this.send('AUTHENTICATE',
                        Buffer.from(
                            this.opt.nick + '\0' +
                            this.opt.userName + '\0' +
                            (this.opt.password ?? '')
                        ).toString('base64'));
                    break;
                case '903':
                    this.send('CAP', 'END');
                    break;

                case 'err_umodeunknownflag':
                    errorLog('\u001b[01;31mERROR: %o\u001b[0m', message);
                    break;

                case 'err_erroneusnickname':
                    errorLog('\u001b[01;31mERROR: %o\u001b[0m', message);
                    this.emit('error', message);
                    break;

                // Commands relating to OPER
                case 'err_nooperhost':
                    this.emit('error', message);
                    errorLog('\u001b[01;31mERROR: %o\u001b[0m', message);
                    break;

                case 'rpl_youreoper':
                    this.emit('opered');
                    break;

                default:
                    if (message.commandType == 'error') {
                        this.emit('error', message);
                        errorLog('\u001b[01;31mERROR: %o\u001b[0m', message);
                    }
                    else {
                        debug('\u001b[01;31mUnhandled message: %o\u001b[0m', message);
                        break;
                    }
            }
        });

        this.addListener('kick', (channel: string) => {
            if (this.opt.autoRejoin)
                this.send('JOIN', ...channel.split(' '));
        });
        this.addListener('motd', () => {
            this.opt.channels.forEach((channel) =>{
                this.send('JOIN', ...channel.split(' '));
            });
        });
    }

    connectionTimedOut(conn: Socket) {
        if (conn !== this.conn) {
            // Only care about a timeout event if it came from the connection
            // that is most current.
            return;
        }
        this.end();
    }

    connectionWantsPing(conn: Socket) {
        if (conn !== this.conn) {
            // Only care about a wantPing event if it came from the connection
            // that is most current.
            return;
        }
        this.send('PING', (this.pingCounter++).toString());
    }

    chanData(name: string, create?: boolean) {
        const key = name.toLowerCase();
        if (create) {
            this.chans[key] = this.chans[key] ?? {
                key: key,
                serverName: name,
                users: {},
                modeParams: {},
                mode: ''
            };
        }

        return this.chans[key];
    };

    _connectionHandler() {
        if (this.opt.webirc.ip && this.opt.webirc.pass && this.opt.webirc.host) {
            this.send('WEBIRC', this.opt.webirc.pass, this.opt.userName, this.opt.webirc.host, this.opt.webirc.ip);
        }
        if (this.opt.sasl) {
            // see http://ircv3.atheme.org/extensions/sasl-3.1
            this.send('CAP REQ', 'sasl');
        } else if (this.opt.password) {
            this.send('PASS', this.opt.password);
        }
        debug('Sending irc NICK/USER');
        this.send('NICK', this.opt.nick);
        this.nick = this.opt.nick;
        this._updateMaxLineLength();
        this.send('USER', this.opt.userName, '8', '*', this.opt.realName);

        this.conn?.cyclingPingTimer?.start();

        this.emit('connect');
    }

    connect(retryCount?: number, callback?: () => void): void;
    connect(callback: () => void): void;
    connect(retryCountOrCallback: number | (() => void) | undefined, callback?: () => void) {
        let retryCount = 0;
        if (typeof (retryCountOrCallback) === 'function') {
            callback = retryCountOrCallback;
        } else {
            retryCount = retryCountOrCallback ?? 0;
        }
        if (callback) {
            this.once('registered', callback);
        }
        this.chans = {};

        // socket opts
        const connectionOpts: ConnectionOptions & NetConnectOpts = {
            host: this.opt.server,
            port: this.opt.port
        };

        // local address to bind to
        if (this.opt.localAddress)
            connectionOpts.localAddress = this.opt.localAddress;

        // try to connect to the server
        if (this.opt.secure) {
            connectionOpts.rejectUnauthorized = !this.opt.selfSigned;

            if (typeof this.opt.secure == 'object') {
                // copy "secure" opts to options passed to connect()
                for (const f in this.opt.secure) {
                    const key = f as keyof ConnectionOptions
                    copyValue(this.opt.secure, connectionOpts, key);
                }
            }

            this.conn = tls.connect(connectionOpts, () => {
                // Should not be possible
                if(!this.conn) throw new Error('Connection is null after tls.connect');
                // callback called only after successful socket connection
                this.conn.connected = true;
                const tlsConn = this.conn as TLSSocket;
                // The type definitons appear to be wrong - authorizationError is definitely a string
                const authorizationError = tlsConn.authorizationError as unknown as string | undefined;
                if (tlsConn.authorized ||
                    (this.opt.selfSigned &&
                        (authorizationError === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
                        authorizationError === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
                        authorizationError === 'SELF_SIGNED_CERT_IN_CHAIN')) ||
                    (this.opt.certExpired &&
                    authorizationError === 'CERT_HAS_EXPIRED')) {
                    // authorization successful

                    if (!this.opt.encoding) {
                        tlsConn.setEncoding('utf-8');
                    }

                    if (this.opt.certExpired &&
                        authorizationError === 'CERT_HAS_EXPIRED') {
                        errorLog('Connecting to server with expired certificate');
                    }

                    this._connectionHandler();
                } else {
                    // authorization failed
                    errorLog('TLS connection error: %o', tlsConn.authorizationError);
                    this.emit('tls-error', tlsConn.authorizationError);
                }
            });
        } else {
            this.conn = net.createConnection(connectionOpts, this._connectionHandler.bind(this));
        }
        this.conn.requestedDisconnect = false;
        this.conn.setTimeout(0);

        // Each connection gets its own CyclingPingTimer. The connection forwards the timer's 'timeout' and 'wantPing' events
        // to the client object via calling the connectionTimedOut() and connectionWantsPing() functions.
        //
        // Since the client's "current connection" value changes over time because of retry functionality,
        // the client should ignore timeout/wantPing events that come from old connections.
        this.conn.cyclingPingTimer = new CyclingPingTimer(this.opt.millisecondsBeforePingTimeout, this.opt.millisecondsOfSilenceBeforePingSent);
        (function(conn, self) {
            if(conn.cyclingPingTimer) {
                conn.cyclingPingTimer.on('pingTimeout', () => {
                    self.connectionTimedOut(conn);
                });
                conn.cyclingPingTimer.on('wantPing', () => {
                    self.connectionWantsPing(conn);
                });
            }
        }(this.conn, this));

        if (!this.opt.encoding) {
            this.conn.setEncoding('utf8');
        }

        let buffer = Buffer.from('');

        const handleData = (chunk: Buffer | string) => {
            this.conn?.cyclingPingTimer?.notifyOfActivity();

            if (typeof (chunk) === 'string') {
                buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
            } else {
                buffer = Buffer.concat([buffer, chunk]);
            }

            const lines = this.convertEncoding(buffer).toString().split(lineDelimiter);

            if (lines.pop()) {
                // if buffer is not ended with \r\n, there's more chunks.
                return;
            } else {
                // else, initialize the buffer.
                buffer = Buffer.from('');
            }

            lines.forEach((line) => {
                if (line.length) {
                    const message = parseMessage(line, this.opt.stripColors);

                    try {
                        this.emit('raw', message);
                    } catch (err) {
                        if (!this.conn?.requestedDisconnect) {
                            throw err;
                        }
                    }
                }
            });
        }

        this.conn.addListener('data', handleData);
        this.conn.addListener('end', () => {
            debug('Connection got "end" event');
        });
        this.conn.addListener('close', () => {
            debug('Connection got "close" event');

            if (this.conn && this.conn.requestedDisconnect)
                return;
            debug('Disconnected: reconnecting');
            if (this.opt.retryCount !== null && retryCount >= this.opt.retryCount) {
                debug('Maximum retry count (%d) reached. Aborting', this.opt.retryCount);
                this.emit('abort', this.opt.retryCount);
                return;
            }

            debug('Waiting %dms before retrying', this.opt.retryDelay);
            setTimeout(() => {
                this.connect(retryCount + 1);
            }, this.opt.retryDelay);
        });
        this.conn.addListener('error', (exception) => {
            this.emit('netError', exception);
            debug('Network error: %o', exception);
        });
    }

    end() {
        if (this.conn) {
            this.conn.cyclingPingTimer?.stop();
            this.conn.destroy();
        }
        this.conn = null;
    }

    disconnect(message?: string, callback?: () => void): void;
    disconnect(callback: () => void): void;
    disconnect(messageOrCallback: string | (() => void) | undefined, callback?: () => void) {
        let message = '';
        if (typeof (messageOrCallback) === 'function') {
            callback = messageOrCallback;
        } else {
            message = messageOrCallback ?? '';
        }
        if(!this.conn) {
            if (typeof(callback) === 'function') {
                callback();
            }
            return;
        }
        message = message || 'node-irc says goodbye';
        if (this.conn.readyState == 'open') {
            let sendFunction;
            if (this.opt.floodProtection && this._sendImmediate && this._clearCmdQueue) {
                sendFunction = this._sendImmediate;
                this._clearCmdQueue();
            } else {
                sendFunction = this.send.bind(this);
            }
            sendFunction.call(this, 'QUIT', message);
        }
        this.conn.requestedDisconnect = true;
        if (typeof (callback) === 'function') {
            this.conn.once('end', callback);
        }
        this.conn.cyclingPingTimer?.stop();
        this.conn.end();
    }

    send(command: string, ...rest: string[]) {
        const args = [command, ...rest];
        // Note that the command arg is included in the args array as the first element

        if (args[args.length - 1]?.match(/\s/) || args[args.length - 1]?.match(/^:/) || args[args.length - 1] === '') {
            args[args.length - 1] = ':' + (args[args.length - 1] ?? '');
        }

        debug('SEND: %o', args);

        if (this.conn && !this.conn.requestedDisconnect) {
            this.conn.write(args.join(' ') + '\r\n');
        }
    }
    _sendImmediate: typeof this.send | undefined;
    _clearCmdQueue: (() => void) | undefined;
    cmdQueue: [string, ...string[]][] = [];

    activateFloodProtection(interval?: number) {
        const safeInterval = interval ?? this.opt.floodProtectionDelay,
            origSend = this.send.bind(this);

        // Wrapper for the original function. Just put everything to on central
        // queue.
        this.send = function(...args) {
            this.cmdQueue.push(args);
        };

        this._sendImmediate = (...args) => {
            origSend.apply(this, args);
        };

        this._clearCmdQueue = function() {
            this.cmdQueue = [];
        };

        const dequeue = () => {
            const args = this.cmdQueue.shift();
            if (args) {
                origSend.apply(this, args);
            }
        };

        // Slowly unpack the queue without flooding.
        setInterval(dequeue, safeInterval);
        dequeue();
    }

    join(channel: string, callback?: (nick: string, message: string) => void) {
        const channelName = channel.split(' ')[0];
        this.once('join' + (channelName ?? ''), (nick, message) => {
            // if join is successful, add this channel to opts.channels
            // so that it will be re-joined upon reconnect (as channels
            // specified in options are)
            if (!this.opt.channels.includes(channel)) {
                this.opt.channels.push(channel);
            }

            if (typeof (callback) == 'function') {
                callback.apply(this, [nick, message]);
            }
        });
        this.send.apply(this, ['JOIN', ...channel.split(' ')]);
    };

    part(channel: string, message?: string, callback?: (nick: string, message: string, message2: string) => void): void;
    part(channel: string, callback: (nick: string, message: string, message2: string) => void): void;
    part(channel: string, messageOrCallback?: string | ((nick: string, message: string, message2: string) => void), callback?: (nick: string, message: string, message2: string) => void) {
        let message: string | undefined = undefined;
        if (typeof (messageOrCallback) === 'function') {
            callback = messageOrCallback;
        } else {
            message = messageOrCallback;
        }
        if (typeof (callback) == 'function') {
            this.once('part' + channel, callback);
        }

        // remove this channel from this.opt.channels so we won't rejoin
        // upon reconnect
        if (this.opt.channels.includes(channel)) {
            this.opt.channels.splice(this.opt.channels.indexOf(channel), 1);
        }

        if (message) {
            this.send('PART', channel, message);
        } else {
            this.send('PART', channel);
        }
    };

    action(channel: string, text?: string) {
        if (typeof text !== 'undefined') {
            text.split(/\r?\n/).filter(function(line) {
                return line.length > 0;
            }).forEach((line) => {
                this.say(channel, '\u0001ACTION ' + line + '\u0001');
            });
        }
    }

    _splitLongLines(words: string, maxLength: number, destination: string[]): string[] {
        maxLength = maxLength || 450; // If maxLength hasn't been initialized yet, prefer an arbitrarily low line length over crashing.
        if (words.length == 0) {
            return destination;
        }
        if (words.length <= maxLength) {
            destination.push(words);
            return destination;
        }
        const c = words[maxLength];
        let cutPos = 0;
        let wsLength = 1;
        if (c?.match(/\s/)) {
            cutPos = maxLength;
        } else {
            let offset = 1;
            while ((maxLength - offset) > 0) {
                const subC = words[maxLength - offset];
                if (subC?.match(/\s/)) {
                    cutPos = maxLength - offset;
                    break;
                }
                offset++;
            }
            if (maxLength - offset <= 0) {
                cutPos = maxLength;
                wsLength = 0;
            }
        }
        const part = words.substring(0, cutPos);
        destination.push(part);
        return this._splitLongLines(words.substring(cutPos + wsLength, words.length), maxLength, destination);
    }

    say(target: string, text?: string) {
        this._speak('PRIVMSG', target, text);
    };

    notice(target: string, text?: string) {
        this._speak('NOTICE', target, text);
    };

    _speak(kind: 'NOTICE' | 'PRIVMSG', target: string, text?: string) {
        const maxLength = Math.min(this.maxLineLength - target.length, this.opt.messageSplit);
        if (typeof text !== 'undefined') {
            text.split(/\r?\n/).filter(function(line) {
                return line.length > 0;
            }).forEach((line) => {
                const linesToSend = this._splitLongLines(line, maxLength, []);
                linesToSend.forEach((toSend) => {
                    this.send(kind, target, toSend);
                    if (kind == 'PRIVMSG') {
                        this.emit('selfMessage', target, toSend);
                    }
                });
            });
        }
    };

    whois(nick: string, callback?: (info: WhoisData) => void) {
        if (typeof callback === 'function') {
            const callbackWrapper = (info: WhoisData) => {
                if (info.nick.toLowerCase() == nick.toLowerCase()) {
                    this.removeListener('whois', callbackWrapper);
                    callback.apply(this, [info]);
                }
            };
            this.addListener('whois', callbackWrapper);
        }
        this.send('WHOIS', nick);
    }

    list(channels?: string, target?: string) {
        const args = [];
        if (channels) {
            args.push(channels);
        }
        if (target) {
            args.push(target);
        }
        this.send.apply(this, ['LIST', ...args]);
    }

    _addWhoisData<K extends keyof WhoisData>(nick: string, key: K, value: WhoisData[K], onlyIfExists?: boolean) {
        if (onlyIfExists && !this._whoisData[nick]) return;
        this._whoisData[nick] = this._whoisData[nick] ?? {nick: nick};
        this._whoisData[nick][key] = value;
    }

    _clearWhoisData(nick: string) {
        // Ensure that at least the nick exists before trying to return
        this._addWhoisData(nick, 'nick', nick);
        const data = this._whoisData[nick];
        delete this._whoisData[nick];
        return data;
    }

    _handleCTCP(from: string, to: string, text: string, type: string, message: ParsedMessage) {
        text = text.slice(1);
        text = text.slice(0, text.indexOf('\u0001'));
        const parts = text.split(' ');
        this.emit('ctcp', from, to, text, type, message);
        this.emit('ctcp-' + type, from, to, text, message);
        if (type === 'privmsg' && text === 'VERSION')
            this.emit('ctcp-version', from, to, message);
        if (parts[0] === 'ACTION' && parts.length > 1)
            this.emit('action', from, to, parts.slice(1).join(' '), message);
        if (parts[0] === 'PING' && type === 'privmsg' && parts.length > 1)
            this.ctcp(from, 'notice', text);
    }

    ctcp(to: string, type: 'privmsg' | 'notice', text: string) {
        this[type === 'privmsg' ? 'say' : 'notice'](to, '\u0001' + text + '\u0001');
    }

    convertEncoding(str: Buffer) {
        let out = str;

        if (this.opt.encoding) {
            let charset: string | null = null;
            try {
                // for now don't try to import the necessary types to make this not require a billion disables

                // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
                const charsetDetector = require('node-icu-charset-detector');
                // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                const Iconv = require('iconv').Iconv;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
                charset = charsetDetector.detectCharset(str);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
                const converter = new Iconv(charset?.toString(), this.opt.encoding);

                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                out = converter.convert(str);
            } catch (err) {
                debug('\u001b[01;31mERROR: %o\u001b[0m', err);
                debug('More context: %o', { str: str, charset: charset });
            }
        }

        return out;
    }

    // blatantly stolen from irssi's splitlong.pl. Thanks, Bjoern Krombholz!
    _updateMaxLineLength() {
        // 497 = 510 - (":" + "!" + " PRIVMSG " + " :").length;
        // target is determined in _speak() and subtracted there
        this.maxLineLength = 497 - this.nick.length - this.hostMask.length;
    }
}
