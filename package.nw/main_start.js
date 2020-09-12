/******************************************************************************
* @license
 Copyright
 This code is strictly confidential and the receiver is obliged to use it
 exclusively for his or her own purposes. No part of Viaccess-Orca code may be
 reproduced or transmitted in any form or by any means, electronic or
 mechanical, including photocopying, recording, or by any information storage
 and retrieval system, without permission in writing from Viaccess S.A.
 The information in this code is subject to change without notice.
 Viaccess S.A. does not warrant that this code is error-free.
 If you find any problems with this code or wish to make comments,
 please report them to Viaccess-Orca.

 Trademarks
 Viaccess-Orca is a registered trademark of Viaccess S.A. © in France and/or other
 countries. All other product and company names mentioned herein are the
 trademarks of their respective owners.
 Viaccess S.A. may hold patents, patent applications, trademarks, copyrights or
 other intellectual property rights over the code hereafter. Unless expressly
 specified otherwise in a written license agreement, the delivery of this code
 does not imply the concession of any license over these patents, trademarks,
 copyrights or other intellectual property.

 ******************************************************************************/

'use strict';

const fs = require('fs');

const EventEmitter = require('events');
const WebSocketServer = require('websocket').server;
const WebSocketClient = require('websocket').client;

const DownloadManager = require('SQDownloadManager.js');

const PHANTOM_HELPER_WS_PROTOCOL = 'sqp-inside-helper';


const VO_CLOSE_APP_ON_DECONNECTION_TIMEOUT = 30000;

// delay post startup after which the silent update checks for a new update package
const VO_SILENT_UPGRADE_CHECK_START_DELAY = 5000;

class VOConnectedAppLoader {

    constructor(appBgContext, destDocument, destWindow, loadedCB) {
        this.appBgContext = appBgContext;
        this.destinationDocument = destDocument;
        this.destinationWindow = destWindow;
        this.loadedCB_ = loadedCB;
    }

    _onScriptLoaded() {
        this._scriptToLoad--;
        if( this._scriptToLoad == 0) {
            this.loadedCB_();
        }
    }

    injectScriptCode(src, scriptId, attributes, cb) {
        if (this.destinationDocument.getElementById(scriptId)) {
            setTimeout(cb, 150);
            return;
        }
        var js, fjs = this.destinationDocument.getElementsByTagName('head')[0];
        js = this.destinationDocument.createElement('script'); js.id = scriptId;
        for(var a=0; a<attributes.length; a++) {
            js.setAttribute(attributes[a].name, attributes[a].value);
        }
        js.onload = function() {
            cb();
        };
        js.src = src;
        fjs.appendChild(js);
    }

    injectCSSCode(src, scriptId, attributes, cb) {
        if (this.destinationDocument.getElementById(scriptId)) {
            setTimeout(cb, 150);
            return;
        }
        var js;
        var fjs = this.destinationDocument.getElementsByTagName('body')[0];
        js = this.destinationDocument.createElement('link'); js.id = scriptId;
        for(var a=0; a<attributes.length; a++) {
            js.setAttribute(attributes[a].name, attributes[a].value);
        }
        js.onload = function() {
            cb();
        };
        js.setAttribute('rel', 'stylesheet');
        fjs.appendChild(js);
        js.href = src;
    }

    _onVOPlayerRequireLoaded() {
        this._requiresToLoad--;
        if( this._requiresToLoad == 0) {
            if(this.appBgContext.ub) {
                // load byte code for SQPlayer and SQRenderer
                this.destinationWindow.nw.Window.get().evalNWBin(null, './node_modules/SQRenderer.js/rcode.bin');
                this.destinationWindow.nw.Window.get().evalNWBin(null, './node_modules/SQPlayer.js/pcode.bin');
                this._onVOPlayerLibrariesLoaded();
            }
            else {
                this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/node_modules/SQRenderer.js/code.js', 'vo-renderer-code', [],
                    function() { this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/node_modules/SQPlayer.js/code.js', 'vo-player-code', [], this._onVOPlayerLibrariesLoaded.bind(this)); }.bind(this)
                );
            }
        }
    }

    startLoadingProcess() {
        this._requiresToLoad = 2; // there are 2 'require' scripts to inject: one for the renderer and one for the player
        this._scriptToLoad = 5; // there are 5 additional scripts to inject

        this.injectCSSCode('file:///' + this.appBgContext.appResourcesPath + '/resources/quickplayer.css', 'vo-player-style', [], this._onScriptLoaded.bind(this));

        this._onVOPlayerLibrariesLoaded = function() {
            this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/resources/vo-player-window-logic.js', 'vo-player-window-logic', [], this._onScriptLoaded.bind(this));
            this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/resources/vo-customer-iframe-mgt.js', 'vo-player-window-logic', [], this._onScriptLoaded.bind(this));
            this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/resources/vo_app_init_logic.js', 'vo-app-init-logic', [{name: 'data-offlineapp', value:'yes'}],
            function() {
                this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/node_modules/SQPlayer.js/vo-player-controller.js', 'vo-player-controller', [], this._onScriptLoaded.bind(this));
                this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/resources/voplayer_ui_setuplogic.js', 'vo-ui-setup-logic', [], this._onScriptLoaded.bind(this));
            }.bind(this));
        };

        this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/node_modules/SQPlayer.js/require.js', 'vo-player-req-code', [], this._onVOPlayerRequireLoaded.bind(this));
        this.injectScriptCode('file:///' + this.appBgContext.appResourcesPath + '/node_modules/SQRenderer.js/require.js', 'vo-renderer-req-code', [], this._onVOPlayerRequireLoaded.bind(this));
    }
}


class VOBackgroundContext extends EventEmitter {

    // define our own log function, to eventually send logs to higher level if an external logger function is given
    internalLog() {
        if(undefined != this.logger) {
            this.logger.apply(null, arguments);
        }
    }

    notifyEvent(event, arg) {
        this.emit(event, arg);
    }

    get remoteWSConnectionsCount() {
        return this.wsConnectionCount;
    }

    constructor() {
        super();
        this.logger = undefined;

        var path = require('path');

        var voNativeNode = require('sqp.js');

        this.appVersion = nw.App.manifest.version;

        this.appScheme = nw.App.manifest.appScheme;

        this.downloadManager = undefined;
        this.sendDownloadersDetailedUpdates = true;

        this.currentAppMode = undefined;

        // WebSocket server reference
        this.websocketServer = undefined;

        // global counter to keep track of how many clients are connected to the application's websocket server
        this.wsConnectionCount = 0;

        // List of all valid WS connections
        this.wsConnections = [];

        // start by assuming the secure mode for websocket will be available, will be canceled if anything goes wrong with paramaters loading
        this.secureWSModeAvailable = true;

        this.getPhrase = undefined;

        this.windowRefs = {};

        this.offlineAppVisible = false;

        this.offlineAppAvailable = false;

        this.playerWindowObject = {
            playbackFromApp: false
        };

        this._closingTimerId = undefined;

        this.isRealClose = false;

        // identify underlying platform on which the runtime currently runs
        this.isWin = /^win/.test(process.platform);
        var nwPath = process.execPath;
        if(this.isWin) {
            var nwDir = path.dirname(nwPath);
        } else {
            var findContent = nwPath.indexOf('/Contents');
            var nwDir = nwPath.substring(0, findContent+9);
        }

        // replace \\ and \ by simple / in the application path to avoid problem with file opening
        this.appPath = nwDir.replace(/\\\\/g, '/');
        this.appPath = this.appPath.replace(/\\/g, '/');

        if(this.isWin) {
            this.appResourcesPath = this.appPath + '/package.nw/';
        }
        else {
            this.appResourcesPath = this.appPath + '/Resources/app.nw/';
        }

        this.deviceUniqueId = voNativeNode.getDeviceUniqueId();
        if(this.isWin) {
            var licensePath =  nwDir.replace(/\//g, '\\\\');
            if(licensePath[licensePath.length-1] != '\\') {
                licensePath = licensePath + '\\';
            }
            this.nativeSDKVersion = voNativeNode.getSDKVersion(licensePath);
        }
        else {
            this.nativeSDKVersion = voNativeNode.getSDKVersion(this.appPath + '/');
        }
        this.internalLog('App Path: ' + this.appPath + '/');

        // check if the binary version of the player module exists (used in app mode when loading the libraries externally)
        this.ub = fs.existsSync(this.appResourcesPath + 'node_modules/SQPlayer.js/pcode.bin');

        this.initDownloadManager();

        setTimeout(this.runSilentUpgrade.bind(this), VO_SILENT_UPGRADE_CHECK_START_DELAY);
    }

    runSilentUpgrade() {
        const SilentUpdater = require('SQSilentUpdate.js');
        var updater = new SilentUpdater(this.appPath, nw.App.manifest, this.appScheme);
        updater.on('updateAvailableForDownload', function() {
            var p = updater.downloadAvailableUpdate();
            p.then(function(result) {
                    updater.prepareLocalUpdatePackage();
                }.bind(this),
                function(cause) {
                    console.error('download update package rejected: ' + cause);
                }.bind(this));
        }.bind(this));
        updater.checkUpdateAvailableOnServer();
    }

    // WebSocket server ------------------------------------------------------------------------

    initWebSocket() {

        // set path of security files for websocket to default
        var secureWebSocketKeyPath = this.appPath + '/wscerts/qp4w-intercom.key.pem';
        var secureWebSocketCertPath = this.appPath + '/wscerts/qp4w-intercom.cert.pem';

        // Load required information for secured web socket
        try {
            // Read certificates to enable HTTPS connection
            this.HTTPSoptions = {
                key: fs.readFileSync(secureWebSocketKeyPath),
                cert: fs.readFileSync(secureWebSocketCertPath)
            };
        }
        catch(err) {
            this.internalLog('Error when loading secure mode certificates: ' + err);
            this.secureWSModeAvailable = false;
        }
    }


    // placeholder for websocket security
    _originIsAllowedForWS(origin) {
        //TODO
        return true;
    }

    _hasProtocolForWS(list, searched) {
        for(var i=0; i<list.length; i++) {
            if (list[i] == searched) return true;
        }
        return false;
    }

    get wsServerRunning() {
        return (undefined != this.websocketServer);
    }

    startWebSocketServer() {

        const http = require('http');
        const https = require('https');

        if(undefined != this.websocketServer) {
            this.internalLog('WebSocket server already running');
            return;
        }
        this.initWebSocket();

        var httpServer = http.createServer(function(request, response) {
            //response.writeHead(404);
            response.end('Plain Websocket support server');
        });
        httpServer.listen(7250, function() {
            this.internalLog((new Date()) + ' HTTP Server is listening on port 7250');
        }.bind(this));

        this.serversForWs = [httpServer];

        if(this.secureWSModeAvailable && ('function' === typeof this.getPhrase) ) {
            this.internalLog('Secured WebSocket mode available');
            if(fs.existsSync(this.appPath + '/wscerts/certs.info')) {
              var data = fs.readFileSync(this.appPath + '/wscerts/certs.info');
              // the first 8 charaters are gibberich to artificially increase the length of the encrypted file
              this.HTTPSoptions.passphrase = this.getPhrase(data).substring(8);
            }
            var httpsServer = https.createServer(this.HTTPSoptions, function(request, response) {
                //response.writeHead(404);
                response.end('Secured Websocket support server');
            });
            httpsServer.listen(7251, function() {
                this.internalLog((new Date()) + ' HTTPS Server is listening on port 7251');
            }.bind(this));
            this.serversForWs = [httpServer, httpsServer];
            this.HTTPSoptions = undefined;
        }
        else {
            this.internalLog('WARNING: Secured WebSocket mode NOT available !');
        }

        this.websocketServer = new WebSocketServer({
            httpServer: this.serversForWs,
            autoAcceptConnections: false
        });

        this.websocketServer.on('request', function(request) {

            this.internalLog("New WS connection from " + request.origin + " with requested protocols " + JSON.stringify(request.requestedProtocols));
            if (!this._originIsAllowedForWS(request.origin)) {
              // Make sure we only accept requests from an allowed origin
              request.reject();
              this.internalLog((new Date()) + ' New connection from origin ' + request.origin + ' rejected.');
              return;
            }
            if(this._hasProtocolForWS(request.requestedProtocols, PHANTOM_HELPER_WS_PROTOCOL)) {
                request.accept(PHANTOM_HELPER_WS_PROTOCOL, request.origin);
            }
            else {
                request.accept(null, request.origin);
            }
        }.bind(this));

        this.websocketServer.on('connect', function(connection) {

            this.internalLog("WS on connect, protocol:" + connection.protocol, ", version: " + connection.webSocketVersion);
            connection.on('message', function(message) {
                if (message.type === 'utf8') {
                    this._processIncomingWSMsg( message.utf8Data);
                }
                else if (message.type === 'binary') {
                    this.internalLog('Received Binary Message of ' + message.binaryData.length + ' bytes');
                }
            }.bind(this));

            connection.on('close', function(reasonCode, description) {
                this.internalLog('Remote WS client ' + connection.remoteAddress + ' disconnected, reason: ' + reasonCode + ", desc: " + description + "protocol: " + connection.protocol);
                if(connection.protocol != PHANTOM_HELPER_WS_PROTOCOL) {
                    this.wsConnectionCount--;
                }
                this.notifyEvent('wsconnectionclosed', {count: this.wsConnectionCount});
                this._onWSConnectionClosed();
            }.bind(this));

            // if the connection has the 'phantom protocol', do not add it in the count of connections
            if(connection.protocol != PHANTOM_HELPER_WS_PROTOCOL) {
                this._killClosingProcess();
                this.wsConnectionCount++;
            }
            this.wsConnections.push(connection);

            this.sendConnectionMessage(connection);

            this.sendPlayerCreatedMsg(connection);
            this.sendDownloadManagerState(connection);

            this.notifyEvent('newwsconnection', {wsConnection: connection, count: this.wsConnectionCount });

        }.bind(this));
    }

    _onWSConnectionClosed() {
        // if there are no more WebSocket client connected, start process to close the app after delay
        if(0 == this.wsConnectionCount) {
            this.internalLog('No WS connection left, start final closing of app');
            this._startFinalClosingProcess();
        }
    }


    postFakeWSMessage(msgTxt) {
        // use timeout to create asynchronous call
        setTimeout(this._processIncomingWSMsg.bind(this), 1, msgTxt);
    }

    processFakeNewConnection(connection) {
        this.sendConnectionMessage(connection);
        this.sendPlayerCreatedMsg(connection);
        this.sendDownloadManagerState(connection);
    }

    sendConnectionMessage(connection) {
        var msg = {
            emitter : 'qp4wruntime',
            event: 'welcome',
            data: {
                comProtocolVersion: 1,
                appVersion: this.appVersion,
                nbRemoteClients: this.wsConnectionCount
            }
        };
        this.internalLog('Sending welcome msg: ', msg);
        connection.sendUTF(JSON.stringify(msg));
    }

    sendPlayerCreatedMsg(connection) {
        var msg = this._buildPlayerCreatedMessage();
        this.internalLog("Sending qp4web_player_created_msg msg: " + JSON.stringify(msg));
        connection.sendUTF(JSON.stringify(msg));
    }

    _buildPlayerCreatedMessage() {
        var msg = {};
        msg.type = "qp4web_player_created_msg";
        msg.id = "quickplayer4web";

        msg.appVersion = this.appVersion;
        msg.quickplayerSDKVersion = this.nativeSDKVersion;
        msg.deviceId = this.deviceUniqueId;

        if(typeof this.playerRef !== "undefined") {
            //retrieve player information
            msg.playerState = this.playerRef.state;
        }
        return msg;
    }

    setPlayerReference(ref) {
        this.playerRef = ref;
        if(this.playerRef != undefined){
            this.emit('playerrefavailable');
        }
    }

    sendPlayerFailedCreateMsg() {
        var msg = {
            emitter: 'player',
            event:'creationfailed'
        };
        this.internalLog("Sending qp4web_player_failed_created_msg msg: " + JSON.stringify(msg));
        this.broadcastMsgToAllRemotes(msg);
    }

    _processIncomingWSMsg(msgText) {

        this.internalLog('_processIncomingWSMsg: ' + msgText);

        // intercept and process 'broadcast', 'appParameters' and downloader-related messages internally, all others move forward to children listeners
        try {
            var msg = JSON.parse(msgText);

            // filter for download manager messages
            var downloadMsg = this._filterWebSocketMessageForDownload(msg);

            this.internalLog('_processIncomingWSMsg filtered by download: ' + downloadMsg);

            // if not download manager message, continue processing
            if(!downloadMsg) {
                switch(msg.type) {
                    case 'action':
                    if(msg.action == 'forcecloseNW') {
                        this.forceCloseNW();
                    }
                    else if(msg.action == 'forceclose') {
                        this.finishApp(msg.stopDownloads);
                    }
                    break;

                    case 'broadcast':
                    this.broadcastMsgToAllRemotes(msg);
                    break;

                    case 'appParameters':
                    this.appParameters = msg.parameters;
                    if(this.appParameters.hasOwnProperty('sendDownloadersDetailedUpdates')) {
                        this.sendDownloadersDetailedUpdates = this.appParameters.sendDownloadersDetailedUpdates;
                    }
                    this.internalLog('_processIncomingWSMsg, got app params', this.appParameters);
                    break;
                }
            }
        } catch(err) {
            this.internalLog('Error: ', err);
        }
        // forward WS message to all listeners on the app context
        this.notifyEvent('wsmessage', {message: msgText});
    }

    closeWebSocketServer() {
        if(this.websocketServer != undefined) {
            this.websocketServer.closeAllConnections();
            this.websocketServer = undefined;
        }
    }

    broadcastMsgToAllRemotes(msg) {
        var txtMsg = JSON.stringify(msg);
        //this.internalLog("broadcast message " + txtMsg);
        for (var i=this.wsConnections.length-1; i>=0; i--) {
            var c = this.wsConnections[i];
            // if the connection is active, send the mesage, otherwise, remove it from the list
            if(c.connected) {
                c.sendUTF(txtMsg);
            }
            else {
                this.wsConnections.splice(i,1);
            }
        }
        this.emit('extWSMessage', txtMsg);
    }

    // -- App lifecycle management  -----------------------------------------------


    // starts the process of closing the application (finish)
    _startFinalClosingProcess() {
        this.internalLog('_startFinalClosingProcess');
        if (undefined == this._closingTimerId) {
            // the application will close for good after 30 s
            this._closingTimerId = setTimeout(this.finishApp.bind(this), VO_CLOSE_APP_ON_DECONNECTION_TIMEOUT);
        }
    }

    // interrupts the closing process if it is active (to recover)
    _killClosingProcess() {
        if (undefined != this._closingTimerId) {
            clearTimeout(this._closingTimerId);
            this._closingTimerId = undefined;
        }
    }

    closeLauncher(callback) {
        var localWS = new WebSocketClient();
        localWS.on('connect',function(connection) {
            this.internalLog("WS with laucher opened - send killQP4WebLauncher");
            connection.sendUTF("killQP4WebLauncher");
            callback();
        }.bind(this));
        localWS.on('connectFailed', function(error) {
            this.internalLog('WS with laucher connection Error: ' + error.toString());
            callback();
        }.bind(this));
        localWS.connect('ws://127.0.0.1:7260');
    }

    finishApp(stopDownloads) {
        this.internalLog('finishApp - START', stopDownloads);
        // FIXME
        if(true == this.offlineAppVisible) {
            this.internalLog('finishApp - The Offline app is visible, we can\'t close now');
            return;
        }

        if(true == this.playerWindowObject.playbackFromApp) {
            this.internalLog('finishApp - The last playback was started by the app, we can\'t close now');
            return;
        }

        //check for ongoing downloads, we cannot close if there are somme still running
        if(undefined != this.downloadManager) {
            if(this.downloadManager.isDownloadCurrentlyRunning) {
                if(true == stopDownloads) {
                    //TODO
                }
                else {
                    this.internalLog('At least one download is still running, we can\'t full close the app');
                    return;
                }
            }
        }
        try {
            if(this.playerRef) {
                //close any ongoing chromecast session
                if(this.playerRef.uiControls.remotePlayer.isConnected) {
                    if(undefined != this.playerRef.uiControls.chromecastSession) {
                        this.playerRef.uiControls.chromecastSession.endSession();
                    }
                }
            }
        }
        catch(e) {}
        this.closeLauncher(this.forceCloseNW.bind(this));
        this.internalLog('finishApp - DONE');
    }

    forceCloseNW() {
        this.emit('runtimeclosing');
        this.isRealClose = true;
        nw.App.closeAllWindows();
    }

    // -- DownloadManager and Downloaders stuff -----------------------------------------------

    sendDownloadManagerState(connection) {
        this.internalLog('sendDownloadManagerState', this.downloadManager);
        if((undefined != this.downloadManager) && (this.downloadManager.state === 'loaded')) {
            try {
                var msg = this.createDownloadManagerLoadedMsg();
                this.internalLog('sendDownloadManagerState msg');
                connection.sendUTF(JSON.stringify(msg));
            }
            catch(e) {this.internalLog('ERRROR', e);}
        }
        else {
            this.internalLog('sendDownloadManagerState not yet loaded');
        }
    }

    initDownloadManager() {
        if(typeof this.downloadManager === 'undefined') {

            // if the app manifest explicitely disables offline viewing
            if(nw.App.manifest.hasOwnProperty('vo_nooffline')) {
                this.internalLog('Download Manager not available per app manifest');
                this.notifyEvent('downloadmanagerunavailable');
                return;
            }

            this.internalLog('Create new download manager');
            this.downloadManager = new DownloadManager(this.appScheme, this.appPath);

            // listens for downloadManager loading state change (loaded or unavailable, depending on QuickPlayer license)
            this.downloadManager.on('loaded', this._onDownloadManagerLoaded.bind(this));

            this.downloadManager.on('unavailable', function(event) {
                this.notifyEvent('downloadmanagerunavailable');
            }.bind(this));
        }
        else {
            this.internalLog('Already initialized');
        }
    }

    _registerDownloaderListeners(mediaId) {

        this.internalLog('_registerDownloaderListeners - START', mediaId);

        var downloader = this.downloadManager.getDownloader(mediaId);
        if(null != downloader) {

            downloader.on('qualitychanged', this.onDownloaderDetailEvent_.bind(this));

            downloader.on('prepared', this.onDownloaderPreparedEvent_.bind(this));
            downloader.on('downloading', this.onDownloaderDetailEvent_.bind(this));
            downloader.on('stopped', this.onDownloaderDetailEvent_.bind(this));
            downloader.on('reset', this.onDownloaderDetailEvent_.bind(this));
            downloader.on('error', this.onDownloaderError_.bind(this));
            downloader.on('networkDown', this.onDownloaderDetailEvent_.bind(this));
            downloader.on('networkBack', this.onDownloaderDetailEvent_.bind(this));

            downloader.on('progress', this.onDownloaderDetailEvent_.bind(this));
            downloader.on('notEnoughSpace', this.onDownloaderNotEnoughSpace_.bind(this));

            // the completed event has dedicated listener as it is not a detail
            downloader.on('completed', this.onDownloaderCompleted_.bind(this));

            downloader.on('offlineNotAllowed', this.onDownloaderNotAllowed_.bind(this));
            downloader.on('offlineKeysRenewalStarted', this.onDownloaderKeysRenewalStarted_.bind(this));
            downloader.on('offlineKeysRenewalCompleted',this.onDownloaderKeysRenewalCompleted_.bind(this));
            downloader.on('offlineKeysRenewalInterrupted',this.onDownloaderKeysRenewalInterrupted_.bind(this));
            downloader.on('offlineKeysRetrieveKeysExpirationCompleted',this.onDownloaderRetrieveKeysExpirationCompleted_.bind(this));
        }
        this.internalLog('_registerDownloaderListeners - DONE');
    }

    onDownloaderDetailEvent_(event)  {
        this.onDownloaderEvent_(event);
    }

    onDownloaderEvent_(event, important) {
        if(true == this.sendDownloadersDetailedUpdates || important) {
            var downloader = this.downloadManager.getDownloader(event.mediaId);
            var dlUpdateMsg = {
                mediaId: event.mediaId,
                state: downloader.state,
                duration: downloader.duration,
                downloadedDuration: downloader.downloadedDuration,
                downloadSpeed: downloader.downloadSpeed,
                quality: downloader.qualityIdx,
                qualities: downloader.qualities,
                localUrl: downloader.localUrl,
                remainingDownloadTime: downloader.remainingDownloadTime,
                requiredFreeSpaceInKiloBytes: downloader.requiredFreeSpaceInKiloBytes
            };
            var msg = {
                emitter:'downloadmanager',
                event:'downloadupdate',
                data: dlUpdateMsg
            };
            this.broadcastMsgToAllRemotes(msg);
        }
    }

    onDownloaderNotEnoughSpace_(event) {
        this.internalLog('notEnoughSpace received @ mainbg');
        this.onDownloaderEvent_(event);
    }

    onDownloaderPreparedEvent_(event) {
        var downloader = this.downloadManager.getDownloader(event.mediaId);
        var dlPreparedMsg = {
            mediaId: event.mediaId,
            state: downloader.state,
            duration: downloader.duration,
            qualities: downloader.qualities
        };
        var msg = {
            emitter:'downloadmanager',
            event:'downloadprepared',
            data: dlPreparedMsg
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    onDownloaderError_(event) {
        var downloader = this.downloadManager.getDownloader(event.mediaId);
        var dlErrorMsg = {
            mediaId: event.mediaId,
            state: downloader.state,
            errorCode: event.error,
            errorMessage: event.strMessage,
            errorExtra: event.extra
        };
        var msg = {
            emitter:'downloadmanager',
            event:'downloaderror',
            data:dlErrorMsg
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    // when downloadManager is loaded, register listeners for downloaders' events
    _onDownloadManagerLoaded(event) {
        this.internalLog('onDownloadManagerLoaded - START');
        this.notifyEvent('downloadmanagerloaded');
        this.downloadManager.on('downloadadded', this._onDownloaderAdded.bind(this));
        this.downloadManager.on('downloadremoved', this._onDownloaderRemoved.bind(this));

        var downloadIds = this.downloadManager.localMediaIds;
        for(var i in downloadIds) {
            this._registerDownloaderListeners(downloadIds[i]);
        }

        this.broadcastMsgToAllRemotes(this.createDownloadManagerLoadedMsg());
        this.internalLog('onDownloadManagerLoaded - DONE');
    }

    _onDownloaderAdded(event) {
        var msg = {
            emitter:'downloadmanager',
            event:'downloadadded',
            data: {
                mediaId: event.mediaId
            }
        };
        this._registerDownloaderListeners(event.mediaId);
        this.broadcastMsgToAllRemotes(msg);
    }

    _onDownloaderRemoved(event) {
        var msg = {
            emitter:'downloadmanager',
            event:'downloadremoved',
            data: {
                mediaId: event.mediaId
            }
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    onDownloaderNotAllowed_(event) {
        var downloader = this.downloadManager.getDownloader(event.mediaId);
        var dlPreparedMsg = {
            mediaId: event.mediaId,
            state: downloader.state,
        };
        var msg = {
            emitter:'downloadmanager',
            event:'downloadofflinenotallowed',
            data: dlPreparedMsg
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    onDownloaderKeysRenewalStarted_(event) {
        var downloader = this.downloadManager.getDownloader(event.mediaId);
        var dlPreparedMsg = {
            mediaId: event.mediaId,
            state: downloader.state,
        };
        var msg = {
            emitter:'downloadmanager',
            event:'downloadkeyrenewalstarted',
            data: dlPreparedMsg
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    onDownloaderKeysRenewalCompleted_(event) {
        var downloader = this.downloadManager.getDownloader(event.mediaId);
        var dlPreparedMsg = {
            mediaId: event.mediaId,
            state: downloader.state,
        };
        var msg = {
            emitter:'downloadmanager',
            event:'downloadkeyrenewalcompleted',
            data: dlPreparedMsg
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    onDownloaderKeysRenewalInterrupted_(event) {
        var downloader = this.downloadManager.getDownloader(event.mediaId);
        var dlPreparedMsg = {
            mediaId: event.mediaId,
            state: downloader.state,
        };
        var msg = {
            emitter:'downloadmanager',
            event:'downloadkeyrenewalinterrupted',
            data: dlPreparedMsg
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    onDownloaderRetrieveKeysExpirationCompleted_(event) {
        var downloader = this.downloadManager.getDownloader(event.mediaId);
        var dlPreparedMsg = {
            mediaId: event.mediaId,
            state: downloader.state,
            keysExpiration: event.keysExpiration,
        };
        var msg = {
            emitter:'downloadmanager',
            event:'downloadretrievekeyexpirationcompleted',
            data: dlPreparedMsg
        };
        this.broadcastMsgToAllRemotes(msg);
    }

    onDownloaderCompleted_(event) {
        this.internalLog('Download complete: ' + event.mediaId);
        this.onDownloaderEvent_(event, true);
        // check if we are still up because of a remaining running download (no WebSocket connection left)
        this.internalLog('Download complete - nb ws connections ' + this.wsConnectionCount);

        if(0 == this.wsConnectionCount) {
            this.internalLog('Download complete - currentlyDownloading ' + this.downloadManager.isDownloadCurrentlyRunning);
            this.internalLog('Download complete - offline app visible ' + this.offlineAppVisible);

            // if so, check if this was the last remaining download running
            if(!this.downloadManager.isDownloadCurrentlyRunning) {
                if(!this.offlineAppVisible && undefined != this.closeOfflineAppFct) {
                    this.closeOfflineAppFct();
                }
            }
        }
    }

    createDownloadManagerLoadedMsg() {

        var msg = {
            emitter:'downloadmanager',
            event:'loaded'
        };
        var data = {
            appVersion: this.appVersion,
            quickplayerSDKVersion: this.downloadManager.sdkVersion,
            deviceId: this.downloadManager.deviceId,
            state: this.downloadManager.state
        };
        var downloadIds = this.downloadManager.localMediaIds;
        var list = {};
        this.internalLog('createDownloadManagerLoadedMsg', downloadIds);
        for(var id in downloadIds) {
            var downloader = this.downloadManager.getDownloader(downloadIds[id]);
            var element = {
                state: downloader.state,
                uri: downloader.uri,
                downloadedDuration: downloader.downloadedDuration,
                duration:  downloader.duration,
                qualities: downloader.qualities
            }
            list[downloadIds[id]] = element;
        }
        data.downloaders = list;
        msg.data = data;
        this.internalLog('createDownloadManagerLoadedMsg DONE', msg);
        return msg;
    }

    _filterWebSocketMessageForDownload(msg) {
        try {
            switch(msg.type) {
            case 'downloadmanageraction':
                if(msg.downloadmanageraction.action === 'setProxy') {
                    if(this.downloadManager.state == 'loaded') {
                        if (msg.downloadmanageraction.hasOwnProperty('proxyUrl') && (msg.downloadmanageraction.proxyUrl!="") &&
                                msg.downloadmanageraction.hasOwnProperty('proxyPort') && (msg.downloadmanageraction.proxyPort!=0)) {
                            this.downloadManager.proxyUrl = msg.downloadmanageraction.proxyUrl;
                            this.downloadManager.proxyPort = parseInt(msg.downloadmanageraction.proxyPort);
                        }
                    }
                }
                else if(msg.downloadmanageraction.action === 'setProxyParameters') {
                    if(this.downloadManager.state == 'loaded') {
                        if (msg.downloadmanageraction.hasOwnProperty('proxyUrl') && (msg.downloadmanageraction.proxyUrl!="") &&
                                msg.downloadmanageraction.hasOwnProperty('proxyPort') && (msg.downloadmanageraction.proxyPort!=0) &&
                                msg.downloadmanageraction.hasOwnProperty('proxyType') && (msg.downloadmanageraction.proxyType>0)) {
                            this.downloadManager.proxyUrl = msg.downloadmanageraction.proxyUrl;
                            this.downloadManager.proxyPort = parseInt(msg.downloadmanageraction.proxyPort);
                            this.downloadManager.proxyType = parseInt(msg.downloadmanageraction.proxyType);
                            this.downloadManager.proxyUsername = msg.downloadmanageraction.proxyUsername;
                            this.downloadManager.proxyPassword = msg.downloadmanageraction.proxyPassword;
                        }
                    }
                }
                return true;

            case 'downloadaction':
                this.executeDownloadCommand_(msg.downloadaction);
                return true;

            case 'offline':
                if(msg.action === 'openOfflineApp') {
                    this.showOfflineApp(true);
                }
                return true;
            }
        }
        catch(e) { this.internalLog(e); }
        return false;
    }

    showOfflineApp(shallShow) {
        if(this.windowRefs.hasOwnProperty('VOOfflineApp')) {
            var win =  this.windowRefs['VOOfflineApp'];
            if(shallShow) {
                win.show();
                win.setShowInTaskbar(true);
                win.setAlwaysOnTop(true);
                win.setAlwaysOnTop(false);
                win.setResizable(true);
                win.focus();
                this.offlineAppVisible = true;
            } else {
                if(this.offlineAppVisible) {
                    this.offlineAppVisible = false;
                    win.hide();
                    win.setShowInTaskbar(false);
                    win.blur();
                }
                else {
                    this.internalLog('Shall HIDE, but window opened by user so keep it');
                }
            }
        }
    }

    executeDownloadCommand_(cmd) {
        if(this.downloadManager.state != 'loaded') {
            this.internalLog('executeDownloadCommand - downloadManager not loaded !');
            return;
        }
        if(!cmd.hasOwnProperty('mediaId')) {
            this.internalLog('executeDownloadCommand - command does not include required mediaId');
            return;
        }
        switch(cmd.action) {
            case 'create':
                var downloader = this.downloadManager.getDownloader(cmd.mediaId);
                if(null == downloader) {
                    var downloader = this.downloadManager.createDownloader(cmd.mediaId, cmd.media);
                }
            break;
            case 'start':
                var downloader = this.downloadManager.getDownloader(cmd.mediaId);
                if(downloader.state == 'error' && downloader.lastErrorCode == 201) {
                    downloader.startDownload(false);
                }
                else if((null != downloader) && (downloader.state != "completed")){
                    if((cmd.qualityIdx != undefined) && (parseInt(cmd.qualityIdx) >= 0))
                    {
                        downloader.qualityIdx = parseInt(cmd.qualityIdx);
                    }
                    if(cmd.audioIdxs != undefined) {
                        downloader.audioIdxs = cmd.audioIdxs;
                    }
                    if(cmd.subtitleIdxs != undefined) {
                        downloader.subtitleIdxs = cmd.subtitleIdxs;
                    }
                    downloader.startDownload(true);
                }
            break;

            case 'pause':
                var downloader = this.downloadManager.getDownloader(cmd.mediaId);
                if(null != downloader) {
                    downloader.stopDownload();
                }
            break;

            case 'remove':
                this.downloadManager.deleteLocalMedia(cmd.mediaId);
            break;

            case 'getkeys':
                var downloader = this.downloadManager.getDownloader(cmd.mediaId);
                if(null != downloader) {
                    downloader.renewOfflineKeys();
                }
            break;

            case 'infoonkeys':
                var downloader = this.downloadManager.getDownloader(cmd.mediaId);
                if(null != downloader) {
                    downloader.offlineKeysExpiration();
                }
            break;

            default:
            this.internalLog('unknown command');
            break;
        }
    }

    openNewWindow(url, params, id) {

        if(this.windowRefs.hasOwnProperty(id)) {
            this.internalLog('A window with id ' + id + ' already exists !');
            return false;
        }

        params.id = id;

        nw.Window.open(url, params, function(win) {
            viaccessorca.appBackgroundContext.windowRefs[id] = win;
            // register a listener on the 'closed' event to be able to clean-up the ref list
            win.on('closed', this._filterOpenedWindowRefs.bind(this));

            win.window.voAppBackgroundContext = this;

            win.on('document-start', function() {
                console.log('Window document start ' + Date.now());
                win.window.voAppBackgroundContext = this;
            }.bind(this));

            win.on('navigation', function(frame, url, policy) {
                console.log('Navigation event: ', frame, url, policy);
                this.internalLog('Navigation event: ', frame, url, policy);
                win.window.voAppBackgroundContext = this;
            }.bind(this));
        }.bind(this));
    }

    _filterOpenedWindowRefs() {
        this.internalLog('_filterOpenedWindowRefs', this.windowRefs);
        for(var id in this.windowRefs) {
            try {
                if(this.windowRefs[i].appWindow.contentWindow.closed) {
                    delete this.windowRefs[i];
                }
            }
            catch(e) {
                delete this.windowRefs[i];
            }
        }
    }

    createPlayerWindow() {

        if(this.windowRefs.hasOwnProperty('VOPlayerWindow')) {
            this.internalLog('The VOPlayerWindow is already created !');
        }

        if(!this.hasOwnProperty('appParameters')) {
            this.appParameters = {};

            this.appParameters.appScheme = nw.App.manifest.appScheme;
            if(nw.App.manifest.hasOwnProperty('localization')) {
                this.appParameters.localization = nw.App.manifest.localization;
            } else {
                this.appParameters.localization = undefined;
            }
            if(nw.App.manifest.hasOwnProperty('player')) {
                this.appParameters.player = nw.App.manifest.player;
            } else {
                this.appParameters.player = { bandwidthThreshold: [], uiParams: {}, volume:0.5};
            }
        }
        var params = {
            show: false,
            frame: nw.App.manifest.window.frame,
            icon: nw.App.manifest.window.icon,
            title: nw.App.manifest.window.title,
            show_in_taskbar: true,
            resizable: true
        }
        this.openNewWindow('player.html', params, 'VOPlayerWindow');
    }

    _processIncomingStartArgs() {
        var startOffline = false;
        //first time entrance argument detection
        var args = nw.App.argv;
        for (var idx = 0; idx < args.length; idx++) {
            if ((args[idx] == 'show') || (args[idx].indexOf('showOffline') > 0)) {
                startOffline = true;
                break;
            }
        }
        //at this stage we do not know if we are in player only or player with offline app.
        //if 'show' was detected as argument then we are sure to be in player with offline app => we start the window resizable
        //else we do not know and we start with a window non resizable
        if(startOffline) {
            viaccessorca.appBackgroundContext.openNewWindow('entry.html', {
                show: true,
                frame: nw.App.manifest.window.frame,
                width: nw.App.manifest.window.width,
                height: nw.App.manifest.window.height,
                show_in_taskbar: true,
                resizable: true
            }, 'VOOfflineApp');
        } else {
            viaccessorca.appBackgroundContext.openNewWindow('entry.html', {
                show: false,
                frame: nw.App.manifest.window.frame,
                show_in_taskbar: true,
                width: nw.App.manifest.window.width,
                height: nw.App.manifest.window.height,
                resizable: true
            }, 'VOOfflineApp');
        }
    }

    startConnectedAppMode(destDocument, destWindow, cb) {
        destWindow.voAppBackgroundContext = this;
        var appLoader = new VOConnectedAppLoader(this, destDocument, destWindow, cb);
        appLoader.startLoadingProcess();
        return this;
    }
}

var viaccessorca = {}
viaccessorca.appBackgroundContext = new VOBackgroundContext();
if(nw.App.manifest.hasOwnProperty('start_page')) {
    viaccessorca.appBackgroundContext.openNewWindow(nw.App.manifest['start_page'], {}, 'vo-start-app');
}
else {
    viaccessorca.appBackgroundContext._processIncomingStartArgs();
}
