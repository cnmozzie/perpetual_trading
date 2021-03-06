const querystring = require('querystring')
const fetch = require("cross-fetch")
const https = require('https')
const { Contract, Wallet, BigNumber, constants, providers } = require("ethers")
const AmmArtifact = require("@perp/contract/build/contracts/Amm.json")
const ClearingHouseArtifact = require("@perp/contract/build/contracts/ClearingHouse.json")
const RootBridgeArtifact = require("@perp/contract/build/contracts/RootBridge.json")
const ClientBridgeArtifact = require("@perp/contract/build/contracts/ClientBridge.json")
const CHViewerArtifact = require("@perp/contract/build/contracts/ClearingHouseViewer.json")
const Erc20TokenArtifact = require("@perp/contract/build/contracts/ERC20Token.json")
const AmmReaderArtifact = require("@perp/contract/build/contracts/AmmReader.json")
const { parseUnits, formatEther, formatUnits } = require("ethers/lib/utils")
require("dotenv").config()

const LONG_POS = 0
const SHORT_POS = 1
const DEFAULT_DECIMALS = 18
const PNL_OPTION_SPOT_PRICE = 0
const ORDER_AMOUNT = "15"


const ABI_AMB_LAYER1 = [
  "event RelayedMessage(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)",
  "event AffirmationCompleted( address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)",
]

const ABI_AMB_LAYER2 = [
  "event AffirmationCompleted( address indexed sender, address indexed executor, bytes32 indexed messageId, bool status)",
]

async function waitTx(txReq) {
  return txReq.then(tx => tx.wait(2)) // wait 2 block for confirmation
}

async function setupEnv() {
  const metadataUrl = "https://metadata.perp.exchange/production.json"
  const metadata = await fetch(metadataUrl).then(res => res.json())
  const xDaiUrl = "https://xdai.poanetwork.dev"
  const mainnetUrl = "https://mainnet.infura.io/v3/" + process.env.INFURA_PROJECT_ID
  const layer1Provider = new providers.JsonRpcProvider(mainnetUrl)
  const layer2Provider = new providers.JsonRpcProvider(xDaiUrl)
  const layer1Wallet = new Wallet(process.env.PRIVATE_KEY, layer1Provider)
  const layer2Wallet = new Wallet(process.env.PRIVATE_KEY, layer2Provider)
  console.log("wallet address", layer1Wallet.address)

  // layer 1 contracts
  const layer1BridgeAddr = metadata.layers.layer1.contracts.RootBridge.address
  const usdcAddr = metadata.layers.layer1.externalContracts.usdc
  const layer1AmbAddr = metadata.layers.layer1.externalContracts.ambBridgeOnEth

  const layer1Usdc = new Contract(usdcAddr, Erc20TokenArtifact.abi, layer1Wallet)
  const layer1Bridge = new Contract(layer1BridgeAddr, RootBridgeArtifact.abi, layer1Wallet)
  const layer1Amb = new Contract(layer1AmbAddr, ABI_AMB_LAYER1, layer1Wallet)

  // layer 2 contracts
  const layer2BridgeAddr = metadata.layers.layer2.contracts.ClientBridge.address
  const layer2AmbAddr = metadata.layers.layer2.externalContracts.ambBridgeOnXDai
  const xUsdcAddr = metadata.layers.layer2.externalContracts.usdc
  const clearingHouseAddr = metadata.layers.layer2.contracts.ClearingHouse.address
  const chViewerAddr = metadata.layers.layer2.contracts.ClearingHouseViewer.address
  const ammAddr = metadata.layers.layer2.contracts.ETHUSDC.address // can change to other address
  const ammReaderAddr = metadata.layers.layer2.contracts.AmmReader.address

  const layer2Usdc = new Contract(xUsdcAddr, Erc20TokenArtifact.abi, layer2Wallet)
  const amm = new Contract(ammAddr, AmmArtifact.abi, layer2Wallet)
  const clearingHouse = new Contract(clearingHouseAddr, ClearingHouseArtifact.abi, layer2Wallet)
  const clearingHouseViewer = new Contract(chViewerAddr, CHViewerArtifact.abi, layer2Wallet)
  const layer2Amb = new Contract(layer2AmbAddr, ABI_AMB_LAYER2, layer2Wallet)
  const layer2Bridge = new Contract(layer2BridgeAddr, ClientBridgeArtifact.abi, layer2Wallet)
  const ammReader = new Contract(ammReaderAddr, AmmReaderArtifact.abi, layer2Wallet)

  console.log("USDC address", usdcAddr)

  return {
    amm,
	ammReader,
    clearingHouse,
    layer1Usdc,
    layer2Usdc,
    layer1Wallet,
    layer2Wallet,
    clearingHouseViewer,
    layer1Bridge,
    layer2Bridge,
    layer1Amb,
    layer2Amb,
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getMarkPrice(ammReader, amm) {
  let ammInfo = await ammReader.getAmmStates(amm.address)
  let quoteAssetReserve = ammInfo[0].div(BigNumber.from("1000000000000000000")).toNumber()
  let baseAssetReserve = ammInfo[1].div(BigNumber.from("1000000000000000000")).toNumber()
  let price = quoteAssetReserve / baseAssetReserve
  return price
}

function getBinancePrice() {
    const promise=new Promise(function (resolve, reject) {
        const req=https.get('https://dapi.binance.com/dapi/v1/ticker/price?symbol=ETHUSD_PERP', (res) => {

          res.on('data', (d) => {
            const jsonObject = JSON.parse(d);
            resolve(jsonObject[0]);
          });

        }).on('error', (e) => {
         console.error(e);
         reject(e);
        });
    })
    return promise;
}

var alert_price_difference = 0.02

async function tick(ammReader, amm, clearingHouse, clearingHouseViewer, layer2Wallet) {
   let mark_price = await getMarkPrice(ammReader, amm)
   let binance_data = await getBinancePrice();
   let price_difference = (binance_data["price"] - mark_price) / mark_price
   console.log("mark price =", mark_price, " binance price=", binance_data["price"])
   console.log("alert price difference=", alert_price_difference*100, " price difference=", price_difference*100)
   if (Math.abs(price_difference) > alert_price_difference) {
	   alert_price_difference = alert_price_difference + 0.02
	   const postData = querystring.stringify({
         'text': 'Abnormal Price Change',
         'desp': 'mark price = ' + mark_price + '\nbinance price = ' + binance_data["price"]
       });
	   const options = {
         hostname: 'sc.ftqq.com',
         port: 443,
         path: '/' + process.env.SC_KEY + '.send',
         method: 'POST',
         headers: {
           'Content-Type': 'application/x-www-form-urlencoded',
           'Content-Length': Buffer.byteLength(postData)
         }
       };
	   const req = https.request(options, (res) => {
         console.log(`STATUS: ${res.statusCode}`);
         console.log(`HEADERS: ${JSON.stringify(res.headers)}`);
         res.setEncoding('utf8');
         res.on('data', (chunk) => {
           console.log(`BODY: ${chunk}`);
         });
         res.on('end', () => {
           console.log('No more data in response.');
         });
       });
	   req.write(postData);
	   req.end();
   }
}

async function main() {
  const {
    amm,
	ammReader,
    clearingHouse,
    layer1Usdc,
    layer2Usdc,
    layer1Wallet,
    layer2Wallet,
    clearingHouseViewer,
    layer1Bridge,
    layer2Bridge,
    layer1Amb,
    layer2Amb,
  } = await setupEnv()
  
  while (true) {
    await tick(ammReader, amm, clearingHouse, clearingHouseViewer, layer2Wallet)
    await sleep(5000)
  }

}

main()