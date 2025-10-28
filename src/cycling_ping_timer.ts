import { EventEmitter } from 'node:events';
import debugBuilder from 'debug';

const timerDebug = debugBuilder('irc:cyclingPingTimer');

/**
 * This class encapsulates the ping timeout functionality. When enough
 * silence (lack of server-sent activity) time passes, an object of this type
 * will emit a 'wantPing' event, indicating you should send a PING message
 * to the server in order to get some signs of life from it. If enough
 * time passes after that (i.e. server does not respond to PING), then
 * an object of this type will emit a 'pingTimeout' event.
 *
 * To start the gears turning, call start() on an instance of this class To
 * put it in the 'started' state.
 *
 * When server-side activity occurs, call notifyOfActivity() on the object.
 *
 * When a pingTimeout occurs, the object will go into the 'stopped' state.
 */
let ctr = 0;

// TODO eventemitter types
export default class CyclingPingTimer extends EventEmitter<{
    'pingTimeout': [],
    'wantPing': []
}> {
    timerNumber = ctr++;
    started = false;

    // Only one of these two should be non-null at any given time.
    loopingTimeout: NodeJS.Timeout | null = null;
    pingWaitTimeout: NodeJS.Timeout | null = null;

    millisecondsBeforePingTimeout: number;
    millisecondsOfSilenceBeforePingSent: number;

    constructor(millisecondsBeforePingTimeout: number, millisecondsOfSilenceBeforePingSent: number) {
        super();
        this.millisecondsBeforePingTimeout = millisecondsBeforePingTimeout;
        this.millisecondsOfSilenceBeforePingSent = millisecondsOfSilenceBeforePingSent;

        this.on('wantPing', () => {
            this.debug('server silent for too long, let\'s send a PING');
            this.pingWaitTimeout = setTimeout(() => {
                this.stop();
                this.debug('ping timeout!');
                this.emit('pingTimeout');
            }, this.millisecondsBeforePingTimeout);
        });
    }
    
    // conditionally log debug messages
    debug(msg: string) {
        timerDebug('CyclingPingTimer %d: %s', this.timerNumber, msg);
    }

    notifyOfActivity() {
        if (this.started) {
            this.stop();
            this.start();
        }
    }

    stop() {
        if (!this.started) {
            return;
        }
        this.started = false;

        if(this.loopingTimeout) {
            clearTimeout(this.loopingTimeout);
            this.loopingTimeout = null;
        }
        if(this.pingWaitTimeout) {
            clearTimeout(this.pingWaitTimeout);
            this.pingWaitTimeout = null;
        }
    }

    start() {
        if (this.started) {
            this.debug('can\'t start, not stopped!');
            return;
        }
        this.started = true;

        this.loopingTimeout = setTimeout(() => {
            this.loopingTimeout = null;
            this.emit('wantPing');
        }, this.millisecondsOfSilenceBeforePingSent);
    }
}
