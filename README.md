ODMP assumes it is the ONLY client on all the slave instances it communicates with,
and additionally that all ODM instances connected to it terminate correctly.
If an ODM client dies, ensure that /die is called on this server to ensure the 
server state is cleaned up correctly.

Because of this, a single instance of ODMP should have a single parent ODM
client to avoid load balancing issues. The easiest way to ensure this, would be to manage
your infrastructure such that ODM and ODMP run on the same server, and have each ODM 
project run on its own server.

A sample run with a local client may be something like:

===============================
docker run -p 3000:3000 opendronemap/nodeodm & 
cd odmp; npm start &
docker docker run --network="host" --rm -v \
  ~/DATASET:/datasets/code opendronemap/odm --project-path /datasets \
  --split 200 --split-overlap 50 --sm-cluster http://localhost:4000
wget localhost:4000/die
===============================

CloudODM is not really supported, but works for the basic cases.
You'll have to configure --sm-cluster to point back to ODMP and ensure 
that the default instance is on the local client so it won't be terminated.

Note: If there is no localServer and a new instance cannot be initialized,
the load balancer will simply return 500 errors until it manages to boot a
new instance. ODM seems to handle flaky server behavior appropriately.
                       
To manage task splitting, implement bootServer and killServer under balancer.js
In the default configuration, ODMP expects a single NodeODM 
instance running on localhost:3000.

This server is deliberately not secured. Manage your security in your
cloud infrastructure. Use a private VPC on aws or similar and ensure
the firewall is configured to not accept public communication.

----------------------------------------------------------------------------


