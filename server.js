#!/usr/bin/env node
/* -*- Mode:js */
/* vim: set expandtab ts=4 sw=4: */
/*
 * You may redistribute this program and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
'use strict';
const Fs = require('fs');
const Net = require('net');
const Udp = require('dgram');
const Crypto = require('crypto');
const Dijkstra = require('node-dijkstra');
const Cjdnsplice = require('cjdnsplice');
const nThen = require('nthen');
const Cjdnskeys = require('cjdnskeys');
const Cjdnsniff = require('cjdnsniff');
const Cjdnsadmin = require('cjdnsadmin');
const Cjdnsann = require('cjdnsann');

// When the size of the log is 1MB plus the size of the initial data set, move to a new log file.
const MAX_LOG_GROWTH = 1000000000;




// DONE
// test dijkstra
// 10 minute expiration
// statefullness
// fix encodingFormNum
// send versions in announcement


// TODO
// inter-supernode channel
// re-enable walking...
// bootstrapping on subnode


const now = () => (+new Date());

const mkLink = (annPeer, ann) => {
    return Object.freeze({
        label: annPeer.label,
        mtu: annPeer.mtu,
        drops: annPeer.drops,
        latency: annPeer.latency,
        penalty: annPeer.penalty,
        encodingFormNum: annPeer.encodingFormNum,
        flags: annPeer.flags,
        time: Number('0x' + ann.timestamp)
    });
};

const linkValue = (link) => {
    return 1;
};

const buildGraph = (ctx) => {
    if (ctx.mut.dijkstra) { return; }
    const dijkstra = ctx.mut.dijkstra = new Dijkstra();
    for (const nip in ctx.nodesByIp) {
        const links = ctx.nodesByIp[nip].inwardLinksByIp;
        const l = {};
        for (const pip in links) { l[pip] = linkValue(links[pip]); }
        ctx.mut.dijkstra.addNode(nip, l);
    }
};

const getRoute = (ctx, src, dst) => {
    if (!src || !dst) { return null; }

    if (src === dst) {
        return { label: '0000.0000.0000.0001', hops: [] };
    }

    buildGraph(ctx);
    // we ask for the path in reverse because we build the graph in reverse.
    // because nodes announce own their reachability instead of announcing reachability of others.
    const path = ctx.mut.dijkstra.path(dst.ipv6, src.ipv6);
    if (!path) { return; }
    path.reverse();
    let last;
    let lastLink;
    const hops = [];
    const labels = [];
    let formNum;

    path.forEach((nip) => {
        const node = ctx.nodesByIp[nip];
        if (last) {
            const link = node.inwardLinksByIp[last.ipv6];
            let label = link.label;
            const curFormNum = Cjdnsplice.getEncodingForm(label, last.encodingScheme);
            if (curFormNum < formNum) {
                label = Cjdnsplice.reEncode(label, last.encodingScheme, formNum);
            }
            labels.push(label);
            hops.push({
                label: label,
                origLabel: link.label,
                scheme: last.encodingScheme,
                inverseFormNum: formNum
            });
            formNum = link.encodingFormNum;
        }
        last = node;
    });
    labels.push('0000.0000.0000.0001');
    const spliced = Cjdnsplice.splice.apply(null, labels);
    return { label: spliced, hops: hops };
};

const nodeAnnouncementHash = (node) => {
    let carry = new Buffer(64).fill(0);
    if (node) {
        for (let i = node.mut.announcements.length - 1; i >= 0; i--) {
            const hash = Crypto.createHash('sha512').update(carry);
            carry = hash.update(node.mut.announcements[i].binary).digest();
        }
    }
    return carry;
};

const peersFromAnnouncement = (ann) => {
    return ann.entities.filter((x) => (x.type === 'Peer'));
};

const encodingSchemeFromAnnouncement = (ann) => {
    const scheme = ann.entities.filter((x) => (x.type === 'EncodingScheme'))[0];
    return scheme ? scheme.scheme : undefined;
};

const versionFromAnnouncement = (ann) => {
    const ver = ann.entities.filter((x) => (x.type === 'Version'))[0];
    return ver ? ver.version : undefined;
};

const AGREED_TIMEOUT_MS = (1000 * 60 * 60 * 20);
const MAX_CLOCKSKEW_MS = (1000 * 10);
const MAX_GLOBAL_CLOCKSKEW_MS = (1000 * 60 * 60 * 20);

const addAnnouncement = (node, ann) => {
    const time = Number('0x' + ann.timestamp);
    const sinceTime = time - AGREED_TIMEOUT_MS;
    const newAnnounce = [];
    const peersAnnounced = {};
    node.mut.announcements.unshift(ann);
    node.mut.announcements.forEach((a) => {
        if (Number('0x' + a.timestamp) < sinceTime) { return; }
        let safe = false;
        const peers = peersFromAnnouncement(a);
        for (let i = 0; i < peers.length; i++) {
            if (peersAnnounced[peers[i].ipv6]) { continue; }
            safe = true;
            peersAnnounced[peers[i].ipv6] = true;
        }
        if (safe) { newAnnounce.push(a); }
    });
    node.mut.announcements.splice(0, node.mut.announcements.length);
    Array.prototype.push.apply(node.mut.announcements, newAnnounce);
};

const mkNode = (ctx, obj) => {
    if (typeof(obj.version) !== 'number') { throw new Error(); }
    if (typeof(obj.key) !== 'string') { throw new Error(); }
    if (typeof(obj.timestamp) !== 'string') { throw new Error(); }
    if (isNaN(Number('0x' + obj.timestamp))) { throw new Error(); }
    let encodingScheme;
    if (typeof(obj.encodingScheme) === 'undefined') {
        const onode = ctx.nodesByIp[obj.ipv6];
        if (onode && typeof(onode.encodingScheme) === 'object') {
            encodingScheme = onode.encodingScheme;
        } else {
            throw new Error("cannot create node we do not know its encoding scheme");
        }
    } else {
        encodingScheme = obj.encodingScheme;
    }
    const out = Object.freeze({
        type: "Node",
        version: obj.version,
        key: obj.key,
        ipv6: Cjdnskeys.publicToIp6(obj.key),
        encodingScheme: encodingScheme,
        inwardLinksByIp: {},
        mut: {
            timestamp: obj.timestamp,
            announcements: [ ]
        }
    });
    if (obj.announcement) {
        out.mut.announcements[0] = obj.announcement;
    }
    return out;
};

const addNode = (ctx, node, overwrite) => {
    if (node.type !== "Node") { throw new Error(); }
    //if (!overwrite && ctx.nodesByKey[node.key]) { throw new Error(); }
    if (!overwrite && ctx.nodesByIp[node.ipv6]) { throw new Error(); }
    //ctx.nodesByKey[node.key] = node;
    ctx.nodesByIp[node.ipv6] = node;
    return node;
};

const buildMsg = (bytes) => {
    const toWrite = new Buffer(8 + bytes.length);
    toWrite.writeUInt32BE(0x5f3759df, 0);
    toWrite.writeUInt32BE(bytes.length, 4);
    bytes.copy(toWrite, 8);
    return toWrite;
};

let logMsg;
const newLog = (ctx) => {
    if (ctx.mut.logStream) {
        ctx.mut.logStream.end();
    }
    ctx.mut.logSize = 0;
    ctx.mut.initLogSize = 0;
    ctx.mut.logStream = Fs.createWriteStream(ctx.logPath + '/log_' + (ctx.mut.logCtr++) + '.bin');
    Object.keys(ctx.nodesByIp).forEach((ip) => {
        const node = ctx.nodesByIp[ip];
        node.mut.announcements.forEach((ann) => {
            logMsg(ctx, buildMsg(ann.binary));
        });
    });
    ctx.mut.initLogSize = ctx.mut.logSize;
};

logMsg = (ctx, bytes) => {
    let i = 0;
    const tryWrite = () => {
        try {
            ctx.mut.logStream.write(bytes);
            ctx.mut.logSize += bytes;
        } catch (e) {
            if (i++ > 10) {
                throw e;
            } else {
                console.log("failed write, trying again in 2 seconds");
                setTimeout(() => {
                    tryWrite(bytes, true);
                }, 2000);
            }
            return;
        }
        if (ctx.mut.logSize - ctx.mut.initLogSize > MAX_LOG_GROWTH) {
            newLog(ctx);
        }
    };
    tryWrite();
};

const propagateMsg = (ctx, bytes) => {
    const toWrite = buildMsg(bytes);
    logMsg(ctx, toWrite);
};

const handleAnnounce = (ctx, annBin, fromNode, shouldLog) => {
    let ann;
    let replyError = 'none';
    console.log("ann: " + annBin.toString('hex'));
    console.log("ann:" + Crypto.createHash('sha512').update(annBin).digest('hex'));
    try {
        ann = Cjdnsann.parse(annBin);
    } catch (e) {
        console.log("bad announcement [" + e.message + "]");
        replyError = "failed_parse_or_validate";
    }
    console.log(ann);
    console.log(+new Date());

    let node;
    if (ann) { node = ctx.nodesByIp[ann.nodeIp]; }

    if (ann && node && node.mut.timestamp > ann.timestamp) {
        console.log("old timestamp");
        replyError = "old_message";
        ann = undefined;
    }

    let maxClockSkew;
    if (fromNode) {
        maxClockSkew = MAX_CLOCKSKEW_MS;
        if (ann && ann.snodeIp !== ctx.mut.selfNode.ipv6) {
            console.log("announcement meant for other snode");
            replyError = "wrong_snode";
            ann = undefined;
        }
    } else {
        maxClockSkew = MAX_GLOBAL_CLOCKSKEW_MS;
    }
    if (ann && Math.abs(new Date() - Number('0x' + ann.timestamp)) > maxClockSkew) {
        console.log("unacceptably large clock skew " +
            (new Date() - Number('0x' + ann.timestamp)));
        replyError = "excessive_clock_skew";
        ann = undefined;
    } else if (ann) {
        console.log("clock skew " + (new Date() - Number('0x' + ann.timestamp)));
    }

    let scheme;
    if (ann && (scheme = encodingSchemeFromAnnouncement(ann))) {
    } else if (node) {
        scheme = node.encodingScheme;
    } else if (ann) {
        console.log("no encoding scheme");
        replyError = "no_encodingScheme";
        ann = undefined;
    }

    let version;
    if (ann && (version = versionFromAnnouncement(ann))) {
    } else if (node) {
        version = node.version;
    } else if (ann) {
        console.log("no version");
        replyError = "no_version";
        ann = undefined;
    }

    if (!ann) {
        return { stateHash: nodeAnnouncementHash(node), debug: replyError };
    }

    const nodex = mkNode(ctx, {
        version: version,
        key: ann.nodePubKey,
        encodingScheme: scheme,
        timestamp: ann.timestamp,
        announcement: ann
    });
    if (node) {
        if (node.mut.timestamp > ann.timestamp) {
            console.log("old announcement, drop");
            return { stateHash: nodeAnnouncementHash(node), debug: replyError };
        } else if (node.version !== nodex.version) {
            console.log("version change, replacing node");
            node = addNode(ctx, nodex, true);
        } else if (JSON.stringify(node.encodingScheme) !== JSON.stringify(nodex.encodingScheme)) {
            console.log("encodingScheme change, replacing node");
            node = addNode(ctx, nodex, true);
        } else if (ann.isReset) {
            console.log("reset message");
            node = addNode(ctx, nodex, true);
            console.log(node.mut.announcements.length + ' announcements');
        } else {
            addAnnouncement(node, ann);
        }
    } else {
        node = addNode(ctx, nodex, false);
    }

    peersFromAnnouncement(ann).forEach((peer) => {
        const ipv6 = peer.ipv6;
        if (peer.label === '0000.0000.0000.0000' && node.inwardLinksByIp[ipv6]) {
            delete node.inwardLinksByIp[ipv6];
            ctx.mut.dijkstra = undefined;
            return;
        }
        const stored = node.inwardLinksByIp[ipv6];
        const newLink = node.inwardLinksByIp[ipv6] = mkLink(peer, ann);
        if (!stored) {
        } else if (newLink.label !== stored.label) {
        } else if (linkValue(newLink) !== linkValue(stored)) {
        } else {
            return;
        }
        ctx.mut.dijkstra = undefined;
    });

    if (shouldLog) { propagateMsg(ctx, ann.binary); }
    return { stateHash: nodeAnnouncementHash(node), error: replyError };
};

const onSubnodeMessage = (ctx, msg, cjdnslink) => {
    if (!msg.contentBenc.sq) { return; }
    console.log(msg.contentBenc.sq.toString('utf8'));
    if (msg.contentBenc.sq.toString('utf8') === 'gr') {
        const srcIp = Cjdnskeys.ip6BytesToString(msg.contentBenc.src);
        const tarIp = Cjdnskeys.ip6BytesToString(msg.contentBenc.tar);
        const src = ctx.nodesByIp[srcIp];
        const tar = ctx.nodesByIp[tarIp];
        console.log("getRoute req " + srcIp + " " + tarIp);
        const r = getRoute(ctx, src, tar);

        if (r) {
            console.log(">> " + r.label);
            msg.contentBenc.n = Buffer.concat([
                Cjdnskeys.keyStringToBytes(tar.key),
                new Buffer(r.label.replace(/\./g, ''), 'hex')
            ]);
            // TODO this is garbage we are sending the same version every time
            msg.contentBenc.np = new Buffer([1, 19]);
        } else {
            console.log(">> not found ");
        }
        msg.contentBenc.recvTime = now();

        delete msg.contentBenc.sq;
        delete msg.contentBenc.src;
        delete msg.contentBenc.tar;
        cjdnslink.send(msg);
    } else if (msg.contentBenc.sq.toString('utf8') === 'ann') {
        const reply = handleAnnounce(ctx, msg.contentBenc.ann, true, cjdnslink);
        reply.txid = msg.contentBenc.txid;
        reply.p = ctx.mut.selfNode.version;
        reply.recvTime = +new Date();
        msg.contentBenc = reply;
        console.log("reply: " + reply.stateHash.toString('hex'));
        cjdnslink.send(msg);
    } else {
        console.log(msg.contentBenc);
    }
};

const service = (ctx) => {
    let cjdns;
    nThen((waitFor) => {
        Cjdnsadmin.connectWithAdminInfo(waitFor((c) => { cjdns = c; }));
    }).nThen((waitFor) => {
        cjdns.Core_nodeInfo(waitFor((err, ret) => {
            if (err) { throw err; }
            const parsedName = Cjdnskeys.parseNodeName(ret.myAddr);
            const ipv6 = Cjdnskeys.publicToIp6(parsedName.key);
            ctx.mut.selfNode = mkNode(ctx, {
                version: parsedName.v,
                key: parsedName.key,
                ipv6: ipv6,
                encodingScheme: ret.encodingScheme,
                inwardLinksByIp: {},
                timestamp: 'ffffffffffffffff'
            });
            console.log("Got selfNode");
        }))
    }).nThen((waitFor) => {
        Cjdnsniff.sniffTraffic(cjdns, 'CJDHT', waitFor((err, cjdnslink) => {
            console.log("Connected to cjdns engine");
            if (err) { throw err; }
            cjdnslink.on('error', (e) => {
                console.error('sniffTraffic error');
                console.error(e.stack);
            });
            cjdnslink.on('message', (msg) => {
                onSubnodeMessage(ctx, msg, cjdnslink);
            });
        }));
    });
};

const Http = require('http');
const testSrv = (ctx) => {
    Http.createServer((req, res) => {
        const ents = req.url.split('/');
        ents.shift();
        if (ents[0] === 'path') {
            ents.shift();
            //res.end(JSON.stringify(ents));
            const srcIp = ents[0];
            const tarIp = ents[1];
            const src = ctx.nodesByIp[srcIp];
            const tar = ctx.nodesByIp[tarIp];
            console.log("getRoute req " + srcIp + " " + tarIp);
            if (!src) { res.end("src not found"); return; }
            if (!tar) { res.end("tar not found"); return; }
            const r = getRoute(ctx, src, tar);
            res.end(JSON.stringify(r, null, '  '));
        } else if (ents[0] === 'walk') {
            const out = [];
            const outLinks = [];
            for (const ip in ctx.nodesByIp) {
                const node = ctx.nodesByIp[ip];
                out.push([
                    "node",
                    Math.floor(Number('0x' + node.mut.timestamp) / 1000),
                    "-",
                    "v" + node.version + ".0000.0000.0000.0001." + node.key,
                    node.encodingScheme
                ]);
                for (const peerIp in node.inwardLinksByIp) {
                    const link = node.inwardLinksByIp[peerIp];
                    const otherNode = ctx.nodesByIp[peerIp];
                    //if (!otherNode) { continue; }
                    outLinks.push([
                        otherNode ? "link" : "oldlink",
                        Math.floor(link.time / 1000),
                        "-",
                        node.key,
                        otherNode ? otherNode.key : peerIp,
                        link.label
                    ]);
                }
            }
            out.push.apply(out, outLinks);
            res.end(out.map(JSON.stringify).join('\n'));
        } else {
            //console.log(req.url);
            res.end(req.url);
        }
    }).listen(3333);
};

const MS_MINUTE = 1000 * 60;
const KEEP_TABLE_CLEAN_CYCLE = 3 * MS_MINUTE;
const EXPIRATION_TIME = 10 * MS_MINUTE;
const keepTableClean = (ctx) => {
    setInterval(() => {
        console.log("keepTableClean()");
        const minTime = now() - EXPIRATION_TIME;
        for (const nodeIp in ctx.nodesByIp) {
            const node = ctx.nodesByIp[nodeIp];
            const n = now();
            if (minTime > Number(node.timestamp)) {
                console.log("forgetting node [" + nodeIp + "]");
                delete ctx.nodesByIp;
                continue;
            }
        }
    }, KEEP_TABLE_CLEAN_CYCLE);
};

const handleStoreFile = (ctx, buf, cb) => {
    let i = 0;
    while (i < buf.length) {
        const magic = buf.readUInt32BE(i); i += 4;
        const len = buf.readUInt32BE(i); i += 4;
        if (magic !== 0x5f3759df) { throw new Error("bad magic"); }
        handleAnnounce(ctx, buf.slice(i, i += len), false, false);
    }
    cb();
};

const main = () => {
    const confIdx = process.argv.indexOf('--config');
    const config = require( (confIdx > -1) ? process.argv[confIdx+1] : './config' );
    config.datastore = config.datastore || './datastore';

    let ctx = Object.freeze({
        //nodesByKey: {},
        //ipnodes: {},
        nodesByIp: {},
        clients: [],

        logPath: config.datastore,
        config: config,

        mut: {
            dijkstra: undefined,
            selfNode: undefined,

            logStream: undefined,
            initLogSize: 0,
            logSize: 0,
            logCtr: 0
        }
    });

    let newestLogFile;
    nThen((waitFor) => {
        Fs.readdir(ctx.logPath, waitFor((err, logFiles) => {
            if (err && err.code === 'ENOENT') {
                Fs.mkdir(ctx.logPath, waitFor((err) => {
                    if (err) { throw err; }
                }));
                return;
            }
            if (err) { throw err; }
            let newestLog = -1;
            let newestFile = '';
            logFiles.forEach((file) => {
                const num = Number(file.replace(/.*_([0-9]+)\.bin$/, (all, a) => (a)));
                if (num > newestLog) {
                    newestLog = num;
                    newestFile = file;
                }
            });
            if (newestLog > -1) {
                newestLogFile = newestFile;
                ctx.mut.logCtr = newestLog + 1;
            }
        }));
    }).nThen((waitFor) => {
        if (!newestLogFile) { return; }
        Fs.readFile(ctx.logPath + '/' + newestLogFile, waitFor((err, ret) => {
            if (err) { throw err; }
            handleStoreFile(ctx, ret, waitFor());
        }));
    }).nThen((waitFor) => {
        newLog(ctx);
        keepTableClean(ctx);
        //if (Config.backboneBind) { backbone(ctx); }
        service(ctx);
        testSrv(ctx);
        //if (Config.walkerCycle) { setupWalker(ctx); }
        //if (Config.connectTo.length) { connectOut(ctx); }
    });
};
main();
