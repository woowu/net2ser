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
    constructor(device, baud, interframeTimeout = 50) {
        super();

        this.serial = new SerialPort({
            path: device,
            baudRate: baud,
            autoOpen: false,
        });
        this._name = device;
        this.timer = null;
        this.buf = null;

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
            this.timer = setTimeout(() => {
                this.emit('data', this.buf);
                this.buf = null;
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
}

class SocketStream extends EventEmitter {
    constructor(port, interframeTimeout = 50) {
        super();

        this.timer = null;
        this.buf = null;
        this.socket = null;

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
                if (c == this.socket) this.socket = null;
            });
            c.on('error', err => {
                console.error('error:', err.message);
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
        if (this.socket) this.socket.write(data);
    }

    end() {
        if (this.socket) this.socket.end();
    }

    name() {
        if (! this.socket) return null;
        return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
    }
}

const writeTrafficLog = (senderName, data, log) => {
    const now = new Date();
    var logLine = moment(new Date()).format('YYYY-MM-DDTHH:mm:ss.SSSZZ');
    logLine += ' ' + senderName + ' ' + data.length + ' ' + data.toString('hex') + '\n';
    log(logLine);
};

const createSerialStream = options => {
    const stream = new SerialStream(options.device, options.baud, options.interFrameTimeout);
    stream.on('data', data => {
        const leftName = options.device;
        const rightName = (stream.peer && ! options.noForward)
            ? stream.peer.name() : null;
        if (! options.noForward)
            console.log(`${leftName} -> ${rightName} len ${data.length}`);
        else
            console.log(`${leftName} len ${data.length}`);
        console.log(dump(data));
        if (rightName) stream.peer.write(data);
        if (options.log) writeTrafficLog(leftName, data, options.log);
    });
    return stream;
};

const createSocketStream = options => {
    const stream = new SocketStream(options.port, options.interFrameTimeout);
    stream.on('data', (data, socket) => {
        const leftName = `${socket.remoteAddress}:${socket.remotePort}`;
        const rightName = (stream.peer && ! options.noForward)
            ? stream.peer.name() : null;
        if (! options.noForward)
            console.log(`${leftName} -> ${rightName} len ${data.length}`);
        else
            console.log(`${leftName} len ${data.length}`);
        console.log(dump(data));
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
        default: 9600,
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
    log,
});
const socketStream = createSocketStream({
    port: argv.port,
    interFrameTimeout: argv.interFrameTimeout,
    log,
});
serialStream.peer = socketStream;
socketStream.peer = serialStream;
