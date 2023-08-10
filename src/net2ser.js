#!/usr/bin/node --harmony
'use strict';

const fs = require('fs');
const net = require('net');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const { SerialPort } = require('serialport');
const dump = require('buffer-hexdump');
const moment = require('moment');

class SerialStream extends EventEmitter {
    constructor(device, baud, interframeTimeout, maxFrameLen, filterNoise) {
        super();

        this.serial = new SerialPort({
            path: device,
            baudRate: baud,
            autoOpen: false,
        });
        this._name = device;
        this.timer = null;
        this.buf = null;
        this._filterNoise = filterNoise;

        this.serial.open(err => {
            if (err) {
                console.error(`Error opening ${device}:`, err.message);
                process.exit();
            }
        });
        this.serial.on('data', data => {
            clearTimeout(this.timer);
            if (! this.buf)
                this.buf = data;
            else
                this.buf = Buffer.concat([this.buf, data]);
            if (this.buf.length >= maxFrameLen) {
                this._indicateData();
                return;
            }
            this.timer = setTimeout(() => {
                this._indicateData();
            }, interframeTimeout);
        });
    }

    write(data) {
        this.serial.write(data);
    }

    end() {
        if (this.serial) this.serial.close();
    }

    name() {
        return this._name;
    }

    _indicateData() {
        const data = this.buf;
        this.buf = null;
        if (this._filterNoise && data.length < 2) { /* note: this is dangouse! */
            console.log('dropping noise: ', data.toString('hex'));
            return;
        }
        this.emit('data', data);
    }
}

class SocketStream extends EventEmitter {
    constructor(port, interframeTimeout, blockTransfer) {
        super();

        this.timer = null;
        this.buf = null;
        this.socket = null;
        this.blockTransfer = blockTransfer;
        this.blockSeqno = 0;

        this.server = net.createServer(c => {
            c.on('data', data => {
                clearTimeout(this.timer);
                if (! this.buf)
                    this.buf = data;
                else
                    this.buf = Buffer.concat([this.buf, data]);
                this.timer = setTimeout(() => {
                    this.emit('data', this.buf, c);
                    this.buf = null;
                }, interframeTimeout);
            });
            c.on('end', () => {
                console.log('client disconnected');
                if (c == this.socket) this.socket = null;
            });
            c.on('error', err => {
                console.error('error:', err.message);
                this.socket = null;
            });

            console.log('new connection from', `${c.remoteAddress}:${c.remotePort}`);

            /* only the lastest connected socket will get data from the serial
             */
            this.socket = c;
        });

        this.server.on('error', err => {
            console.error('error:', err.message);
        });
        this.server.listen(port, () => {
            console.log('listening on port', port);
        });
    }

    write(data) {
        const BLOCK_HEAD = 0x3e;
        if (! this.socket) return;
        if (! this.blockTransfer) this._writeSocket(data);

        const t = new Date().getTime();
        const ab = new ArrayBuffer(1 + 4 + 8 + 4);
        new DataView(ab).setUint8(0, BLOCK_HEAD);
        new DataView(ab).setUint32(1, this.blockSeqno);
        new DataView(ab).setBigInt64(1 + 4, BigInt(t));
        new DataView(ab).setUint32(1 + 4 + 8, data.length);
        const block = Buffer.concat([Buffer.from(ab), data]);
        console.log('send block', block.slice(0, 20), '...');
        this._writeSocket(block);

        if (++this.blockSeqno == 0xffffffff)
            this.blockSeqno = 0;
    }

    end() {
        if (this.socket) this.socket.end();
    }

    name() {
        if (! this.socket) return null;
        return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
    }

    _writeSocket(data) {
        try {
            this.socket.write(data);
        }
        catch (e) {
            console.error(e.message);
        }
    }
}

const writeTrafficLog = (senderName, data, log) => {
    const now = new Date();
    var logLine = moment(new Date()).format('YYYY-MM-DDTHH:mm:ss.SSSZZ');
    logLine += ' ' + senderName + ' ' + data.length + ' ' + data.toString('hex') + '\n';
    log(logLine);
};

const printData = data => {
    console.log(dump(data));
};

const createSerialStream = options => {
    const stream = new SerialStream(
        options.device, options.baud,
        options.interFrameTimeout, options.maxFrameLen, 
        options.filterNoise);
    stream.on('data', data => {
        const leftName = options.device;
        const rightName = (stream.peer && ! options.noForward)
            ? stream.peer.name() : null;
        if (! options.silence && ! options.noForward)
            console.log(`${leftName} -> ${rightName} len ${data.length}`);
        else if (! options.silence)
            console.log(`${leftName} len ${data.length}`);
        if (! options.silence) printData(data);
        if (rightName) stream.peer.write(data);
        if (options.log) writeTrafficLog(leftName, data, options.log);
    });
    return stream;
};

const createSocketStream = options => {
    const stream = new SocketStream(options.port,
        options.interFrameTimeout, options.blockTransfer);
    stream.on('data', (data, socket) => {
        const leftName = `${socket.remoteAddress}:${socket.remotePort}`;
        const rightName = (stream.peer && ! options.noForward)
            ? stream.peer.name() : null;
        if (! options.silence && ! options.noForward)
            console.log(`${leftName} -> ${rightName} len ${data.length}`);
        else if (! options.silence)
            console.log(`${leftName} len ${data.length}`);
        if (! options.silence) printData(data);
        if (rightName) stream.peer.write(data);
        if (options.log) writeTrafficLog(leftName, data, options.log);
    });
    return stream;
};

const makeLogger = file => {
    const logStream = fs.createWriteStream(file);
    const queue = [];
    var buffWaiting = false;

    const write = () => {
        while (queue.length) {
            const line = queue.shift();
            if (! logStream.write(line)) {
                logStream.once('drain', write);
                buffWaiting = true;
                break;
            }
            buffWaiting = false;
        }
    };

    logStream.on('error', err => {
        console.error(err.message);
        process.exit(1);
    });

    return line => {
        queue.push(line);
        if (queue.length > 1 || buffWaiting) return;
        process.nextTick(write);
    };
};

const argv = require('yargs/yargs')(process.argv.slice(2))
    .version('0.0.1')
    .option('device', {
        alias: 'd',
        describe: 'Serial device name',
        demandOption: true,
        nargs: 1,
    })
    .option('baud', {
        alias: 'b',
        describe: 'Serial device baudrate',
        nargs: 1,
        type: 'number',
        default: 115200,
    })
    .option('port', {
        alias: 'p',
        describe: 'port number',
        nargs: 1,
        type: 'number',
        default: 4059,
    })
    .option('inter-frame-timeout', {
        alias: 't',
        describe: 'inter-frame-timeout',
        nargs: 1,
        type: 'number',
        default: 50,
    })
    .option('max-frame-len', {
        alias: 's',
        describe: 'max frame length when receiving from serial port',
        nargs: 1,
        type: 'number',
        default: 128,
    })
    .option('filter-noise', {
        alias: 'N',
        describe: 'drop octets on the serial port side caused by noise',
    })
    .option('silence', {
        alias: 'S',
        describe: 'silence',
    })
    .option('block-transfer', {
        describe: 'send to tcp in blocks',
    })
    .option('log', {
        alias: 'l',
        describe: 'log file',
        type: 'string',
    })
    .argv;

const log = argv.log ? makeLogger(argv.log) : null;
const serialStream = createSerialStream({
    device: argv.device,
    baud: argv.baud,
    interFrameTimeout: argv.interFrameTimeout,
    maxFrameLen: argv.maxFrameLen,
    filterNoise: argv.filterNoise,
    silence: argv.silence,
    log,
});
const socketStream = createSocketStream({
    port: argv.port,
    interFrameTimeout: argv.interFrameTimeout,
    silence: argv.silence,
    blockTransfer: argv.blockTransfer,
    log,
});
serialStream.peer = socketStream;
socketStream.peer = serialStream;
