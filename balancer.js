var express = require('express');
var proxy = require('express-http-proxy')
var router = express.Router();
let parse = require('parse-headers')

//------------------configuration--------------------------------------------
//Note: ODMP assumes it is the ONLY client on all the slave instances it communicates with,
//and additionally that all ODM instances connected to it terminate correctly.
//If an ODM client dies, ensure that /die is called on this server to ensure the 
//server state is cleaned up correctly.
//
//Because of this, a single instance of ODMP should have a single parent ODM
//client to avoid load balancing issues. The easiest way to ensure this, would be to manage
//your infrastructure such that ODM and ODMP run on the same server, and have each ODM 
//project run on its own server.
//
//A sample run with a local client may be something like:
//
//===============================
//docker run -p 3000:3000 opendronemap/nodeodm & 
//cd odmp; npm start &
//docker docker run --network="host" --rm -v \
//  ~/DATASET:/datasets/code opendronemap/odm --project-path /datasets \
//  --split 200 --split-overlap 50 --sm-cluster http://localhost:4000
//wget localhost:4000/die
//===============================
//
//CloudODM is not really supported, but works for the basic cases.
//You'll have to configure --sm-cluster to point back to ODMP and ensure 
//that the default instance is on the local client so it won't be terminated.
//
//Note: If there is no localServer and a new instance cannot be initialized,
//the load balancer will simply return 500 errors until it manages to boot a
//new instance. ODM seems to handle flaky server behavior appropriately.
let localServer = "localhost:3000"

//The loadThreshold is how many tasks have to be running on the server
//with the least tasks before a new server is started
let loadThreshold = 1;

//maxImages is an image limit for a single task
let maxImages = 1000;

//How long we wait before a server lacking tasks is shut down
let cleanupThreshold = 60000;

//This is a hint to the client how many tasks it should attempt to send us in parallel.
//I'm not sure if this is respected, but if it is it should help limit the number of
//spot nodes
let maxParallelTasks = 10;
                        
//implement these for your infra to let new instances boot when required.
let bootServer = async () => {return false} //TODO await aws ec2 runinstance spot; return 'serverip:serverport'
let killServer = async (server) => {} //TODO aws ec2 terminate instance


//----------------------------------------------------------------------------

//Here's our server state
let servers = []
let serverLists = {} //serverIp:[uuid,uuid,uuid]
serverLists[localServer] = []
servers.push(localServer)
let taskServer = {} //{uuid:serverIp, uuid:serverIp, uuid:serverIp}
let cleaners = {}
let dying = false;

function selectNode(strategy){
    //This is our load balancing strategies. We select a strategy based on the requirements
    //of each individual API call.
    if(strategy == "any") return function anyStrategy(req){
        //The 'any' strategy simply returns the first server.
        return servers[0];
    }; 
    else if(strategy == "balance") return function createStrategy(req){
        //The 'balance' strategy decides on a target server based on current server load.

        //Assuming all servers and tasks are equal, all tasks are cleaned up correctly, 
        //and all servers only speak to us; return the server with the fewest configured tasks.
        var minLoad = serverLists[servers[0]].length;
        var targetServerId = servers[0];
        for(i in serverLists){
            if(serverLists[i].length < minLoad){
                targetServerId = i;
                minLoad = serverLists[i].length;
            }
        }

        //The selected server shouldn't be terminated, so we remove it from the cleanup list
        if(cleaners[targetServerId]){
            clearTimeout(cleaners[targetServerId]);
            delete cleaners[targetServerId];
        }
        return targetServerId;
    }; 
    else if(strategy == "body") return function bodyStrategy(req){
        //The 'body' strategy receives a target uuid in the body of the request,
        //or we extracted it configured the req.data.server parameter - as done
        //when a task is removed and we wouldn't be able to find it otherwise in
        //the remove call.
        return taskServer[req.body.uuid] || req.data.server;
    };
    else if(strategy == "path") return function pathStrategy(req){
        //In the 'path' strategy, we receive the target uuid from the path.
        return taskServer[req.params.uuid];
    }; 
    else throw new Exception("wat")
}


const createTaskFilter = async (req, res) => {
    //In this filter, we check whether to start a new server or not 
    //before handling a task request.
    //To do this, the filter looks for the server with the least 
    //number of tasks, and compares it to a threshold.
    var minLoad = servers.length>0?serverLists[servers[0]].length:loadThreshold;
    for(i in serverLists){
        if(serverLists[i].length < minLoad){
            minLoad = serverLists[i].length;
        }
    }

    if(minLoad >= loadThreshold && dying == false){
        
        let serverId = await bootServer();
        if(serverId != false){
            servers.push(serverId);
            serverLists[serverId] = [];
        }
    } 
    
    return true;
}
async function shutdownServer(server) {
    //Shut down a server and remove it from our state management,
    //unless it's the optional local server.
    if(server == localServer) return false; 
    
    delete serverLists[server];
    const i = servers.indexOf(server);
    if(i > -1) servers.splice(i, 1);

    let e = [];
    for(var u in taskServer) {
        if(taskServer[u] == server) e.push(u);
    }
    for(var c in e){
        delete taskServer[e[c]];
    }

    await killServer(server);

    return true;
}

function attemptCleanup(server){
    //Schedule an instance without tasks to be shut down.
    if(serverLists[server].length == 0){
        cleaners[server] = setTimeout(() => {shutdownServer(server);}, cleanupThreshold);
    }
}

let eraseTask = function(req,res,next) {
    //To manage server state in a viable manner, we
    //are assuming ODM calls /task/remove and /task/cancel.
    //This is true unless the ODM process dies. If
    //it dies, /die MUST be called afterwards
    //to ensure odmp cleans up any lingering instances.
    const uuid = req.body.uuid;
    
    const server = taskServer[uuid]
    delete taskServer[uuid];
    const elem = serverLists[server].indexOf(uuid);
    if(elem > -1)
        serverLists[server].splice(elem, 1)
    req.data = {server}

    attemptCleanup(server);

    next()
}
//A non-API request we can use locally to terminate all instances
router.get('/die', async function(req,res) {
    dying = true;
    const s = [...servers];
    let f = []
    for(var i in s){ f.push(shutdownServer(s[i])); }
    Promise.all(f);
    res.status(200).end();
    setTimeout(() => process.exit(0), 1000);

});
//Below, we implement the NodeODM api calls.

router.get('/auth/info', function(req,res,next) {
  res.status(200).send({loginUrl:'/auth/login', message:"odmp", registerUrl:null});
});
router.post('/auth/login', function(req,res,next) {
  res.status(200).send({token:"token"});
});
router.post('/auth/register', function(req,res,next) {
  res.status(200).send({});
});
router.get('/info', function(req,res,next) {
  //This one we implement locally to allow ODM to identify our proxy
  res.status(200).send({
    engine:'odmp',
    engineVersion:'1',
    maxImages,
    maxParallelTasks,
    taskQueueCount: servers.reduce((total, current) => total + serverLists[current].length),
    version:"1"
  });
});

//The options call provides configuration details.
//I have no idea how NodeODM works or what it supports, 
//so just let the instance reply. ¯\_(ツ)_/¯
router.get('/options', proxy(selectNode("any"), {memoizeHost:false, reqBodyEncoding:null, parseReqBody: false}));

//odmp is built under the assumption that we'll be the only
//consumer for any instances, so list is a local call summing
//all the created tasks we know about.
router.get('/task/list', function(res,req,next) {
    let a = [];
    for (var i in serverLists){
        a = a.concat(serverLists[i])
    }
    res.status(200).res(a)
});

//Define a node to use for our requests
router.post('/task/new/init', proxy(selectNode("balance"), {filter: createTaskFilter, memoizeHost:false, reqBodyEncoding:null, parseReqBody: false, userResDecorator: function(pRes, pResData, uReq, uRes){
    //During the reply, we have to identify the host and port so we can add the task uuid. 
    //This is, err, a bit of a hack, since the uuid isn't guaranteed to be available before the reply.
    const header = parse(pRes.req._header)
    const host = header.host;
    const uuid = JSON.parse(pResData.toString('utf8')).uuid;
    console.dir(host)
    serverLists[host].push(uuid)
    taskServer[uuid] = host
    return pResData;
}}));
router.post('/task/new', proxy(selectNode("balance"), {filter: createTaskFilter, memoizeHost:false, reqBodyEncoding:null, parseReqBody: false, userResDecorator: function(pRes, pResData, uReq, uRes){
    //During the reply, we have to identify the host and port so we can add the task uuid.
    //This is, err, a bit of a hack, since the uuid isn't guaranteed to be available before the reply.
    const header = parse(pRes.req._header)
    const host = header.host;
    const uuid = JSON.parse(pResData.toString('utf8')).uuid;
    serverLists[host].push(uuid)
    taskServer[uuid] = host
    return pResData;
}}));

//Find target node from the JSON post body on these requests
router.use('/task/cancel', express.json())
router.use('/task/remove', express.json())
router.use('/task/restart', express.json())

//When we cancel or remove a task, delete it from our task list.
//This means the server will throw a 500 error if a client
//attempts to reuse the task. This is fine.
router.use('/task/remove', eraseTask);
router.use('/task/cancel', eraseTask);
router.post('/task/restart', proxy(selectNode("body"), {memoizeHost:false})); //uuid
router.post('/task/cancel', proxy(selectNode("body"), {memoizeHost:false})); //uuid

//We're not doing anything special on these calls. Just pass them forward with the corresponding strategy
router.post('/task/remove', proxy(selectNode("body"), {memoizeHost:false})); //uuid
router.post('/task/new/upload/:uuid', proxy(selectNode("path"), {memoizeHost:false, reqBodyEncoding:null, parseReqBody: false})); //uuid
router.post('/task/new/commit/:uuid', proxy(selectNode("path"), {memoizeHost:false})); //uuid
router.get('/task/:uuid/download/:asset', proxy(selectNode("path"), {memoizeHost:false})); //uuid
router.get('/task/:uuid/info', proxy(selectNode("path"), {memoizeHost:false})); //uuid
router.get('/task/:uuid/output', proxy(selectNode("path"), {memoizeHost:false})); //uuid


module.exports = router;
