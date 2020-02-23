ODMP is a minimalistic reverse proxy, load balancer, and cluster manager written to work with the NodeODM API.
I felt it was necessary to provide a permissive license alternative for clustered ODM cloud processing, which will hopefully encourage more people to build NodeODM-based processing platforms.

Currently, ODMP is only a day or two worth of work, and therefore makes several assumptions that help simplify the implementation. 

First of all, ODMP assumes it is the only master for all the slave instances it communicates with,
and additionally that all clients both manage their state correctly in communication with ODMP, and terminate gracefully.

If an ODM client dies, call /die on this server to ensure the instances are shut down before ODMP is terminated, or use a cluster instance initialization scheme that keeps track of nodes outside ODMP and allows for some other form of management.

Because of this, a single instance of ODMP should have a single parent ODM client to avoid load balancing issues. The easiest way to ensure this, would be to manage your infrastructure such that ODM and ODMP run on the same server, and have each ODM 
project run on its own server.

A sample run may be something like:

```
docker run -p 3000:3000 opendronemap/nodeodm & 
cd odmp; npm start &
docker docker run --network="host" --rm -v \
  ~/DATASET:/datasets/code opendronemap/odm --project-path /datasets \
  --split 200 --split-overlap 50 --sm-cluster http://localhost:4000
wget localhost:4000/die
```

CloudODM is not really supported, but probably works for the basic cases. You'll have to configure --sm-cluster to point back to ODMP and ensure that the default instance is on an instance that won't be terminated before the results are transmitted back.

Note: If there is no localServer and a new instance cannot be initialized, the load balancer will simply return 500 errors until it manages to boot a new instance. ODM seems to handle this server behavior appropriately.

To manage task splitting, implement bootServer and killServer under balancer.js 
In the default configuration, ODMP expects a single NodeODM instance running on localhost:3000. bootServer and killServer are implemented as NOPs. A boot script like "sudo apt install docker && sudo docker run -p 3000:3000 opendronemap/nodeodm" on an ubuntu instance should be enough for a basic setup though. I may add this at some point.

This server is deliberately not secured since it is not built for public access. Manage your security in your cloud infrastructure and don't open this server to the public.

Issues and pull requests are appreciated!
