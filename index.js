const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const cliProgress = require("cli-progress");
require("dotenv").config();
const { ApiPromise } = require("@polkadot/api");
const { HttpProvider } = require("@polkadot/rpc-provider");
const { xxhashAsHex } = require("@polkadot/util-crypto");
const execFileSync = require("child_process").execFileSync;
const execSync = require("child_process").execSync;
const binaryPath = path.join(__dirname, "data", "hydra-dx");
const wasmPath = path.join(__dirname, "data", "hydra_dx_runtime.compact.wasm");
const schemaPath = path.join(__dirname, "data", "schema.json");
const hexPath = path.join(__dirname, "data", "runtime.hex");
const originalSpecPath = path.join(__dirname, "data", "genesis.json");
const forkedSpecPath = path.join(__dirname, "data", "fork.json");
const storagePath = path.join(__dirname, "data", "storage.json");

const dev = false;

// Using http endpoint since substrate's Ws endpoint has a size limit.
const provider = new HttpProvider(
  process.env.HTTP_RPC_ENDPOINT || "https://archive.snakenet.hydradx.io:9922/"
);
// The storage download will be split into 256^chunksLevel chunks.
const chunksLevel = process.env.FORK_CHUNKS_LEVEL || 1;
const totalChunks = Math.pow(256, chunksLevel);

let chunksFetched = 0;
let separator = false;
const progressBar = new cliProgress.SingleBar(
  {},
  cliProgress.Presets.shades_classic
);

// CLEAR storage maps from forked spec. WARNING!
// ALL OTHER DATA WILL BE COPIED FROM THE PREV SPEC.
// MAKE SURE TO CLEAR DATA SO WE DON'T HAVE CONFLICTS.
let clearPrefixes = [
  "0x1cb6f36e027abb2091cfb5110ab5087faacf00b9b41fda7a9268821c2a2b3e4c", // Babe/NextAuthorities
  "0xcec5070d609dd3497f72bde07fc96ba0726380404683fc89e8233450c8aa1950", // Session/KeyOwner
  "0xcec5070d609dd3497f72bde07fc96ba04c014e6bf8b8c2c011e7290b85696bb3", // Session/NextKeys
  "0x5f3e4907f716ac89b6347d15ececedca3ed14b45ed20d054f05e37e2542cfe70", // Staking/Bonded
  "0x5f3e4907f716ac89b6347d15ececedca88dcde934c658227ee1dfafcd6e16903", // Staking/Validators
  "0x5f3e4907f716ac89b6347d15ececedca308ce9615de0775a82f8a94dc3d285a1", // Staking/StorageVersion
  "0x5f3e4907f716ac89b6347d15ececedca9220e172bed316605f73f1ff7b4ade98", // Staking/Payee
  "0x5f3e4907f716ac89b6347d15ececedca9c6a637f62ae2af1c7e31eed7e96be04", // Staking/Nominators
  "0x5f3e4907f716ac89b6347d15ececedca422adb579f1dbf4f3886c5cfa3bb8cc4", // Staking/Ledger
  "0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb", // Timestamp/Now
  "0xd5c41b52a371aa36c9254ce34324f2a5", // Offences
  "0x26aa394eea5630e07c48ae0c9558cef7", // System
];

// List of modules to be skipped from the new chain.
// You can still specify specific storage prefixes to include. Even if you skip it here.
const skippedModulesPrefix = [
  "Authorship",
  "System",
  "Staking",
  "Session",
  "Babe",
  "Grandpa",
  "ImOnline",
  "PhragmenElection",
  "ElectionProviderMultiPhase",
  "Treasury",
  "Timestamp",
  "GrandpaFinality",
  "FinalityTracker",
];

/**
 * All module prefixes except those mentioned in the skippedModulesPrefix will be added to this by the script.
 * If you want to add any past module or part of a skipped module, add the prefix here manually.
 *
 * Any storage value’s hex can be logged via console.log(api.query.<module>.<call>.key([...opt params])),
 * e.g. console.log(api.query.timestamp.now.key()).
 *
 * If you want a map/doublemap key prefix, you can do it via .keyPrefix(),
 * e.g. console.log(api.query.system.account.keyPrefix()).
 *
 * For module hashing, do it via xxhashAsHex,
 * e.g. console.log(xxhashAsHex('System', 128)).
 */
let prefixes = [
  "0x26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9", // System/Account
  "0xcec5070d609dd3497f72bde07fc96ba0726380404683fc89e8233450c8aa1950", // Session/KeyOwner
  "0xcec5070d609dd3497f72bde07fc96ba04c014e6bf8b8c2c011e7290b85696bb3", // Session/NextKeys
  "0x5f3e4907f716ac89b6347d15ececedca3ed14b45ed20d054f05e37e2542cfe70", // Staking/Bonded
  "0x5f3e4907f716ac89b6347d15ececedca88dcde934c658227ee1dfafcd6e16903", // Staking/Validators
  "0x5f3e4907f716ac89b6347d15ececedca308ce9615de0775a82f8a94dc3d285a1", // Staking/StorageVersion
  "0x5f3e4907f716ac89b6347d15ececedca9220e172bed316605f73f1ff7b4ade98", // Staking/Payee
  "0x5f3e4907f716ac89b6347d15ececedca9c6a637f62ae2af1c7e31eed7e96be04", // Staking/Nominators
  "0x5f3e4907f716ac89b6347d15ececedca422adb579f1dbf4f3886c5cfa3bb8cc4", // Staking/Ledger
];

async function main() {
  if (!fs.existsSync(binaryPath)) {
    console.log(
      chalk.red(
        'Binary missing. Please copy the binary of your substrate node to the data folder and rename the binary to "binary"'
      )
    );
    process.exit(1);
  }
  execFileSync("chmod", ["+x", binaryPath]);

  if (!fs.existsSync(wasmPath)) {
    console.log(
      chalk.red(
        'WASM missing. Please copy the WASM blob of your substrate node to the data folder and rename it to "runtime.wasm"'
      )
    );
    process.exit(1);
  }
  execSync("cat " + wasmPath + " | hexdump -ve '/1 \"%02x\"' > " + hexPath);

  let api;
  console.log(
    chalk.green(
      "We are intentionally using the HTTP endpoint. If you see any warnings about that, please ignore them."
    )
  );
  if (!fs.existsSync(schemaPath)) {
    console.log(chalk.yellow("Custom Schema missing, using default schema."));
    api = await ApiPromise.create({ provider });
  } else {
    const { types, rpc } = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    api = await ApiPromise.create({
      provider,
      types,
      rpc,
    });
  }

  if (fs.existsSync(storagePath)) {
    console.log(
      chalk.yellow(
        "Reusing cached storage. Delete ./data/storage.json and rerun the script if you want to fetch latest storage"
      )
    );
  } else {
    // Download state of original chain
    console.log(
      chalk.green(
        "Fetching current state of the live chain. Please wait, it can take a while depending on the size of your chain."
      )
    );
    progressBar.start(totalChunks, 0);
    const stream = fs.createWriteStream(storagePath, { flags: "a" });
    stream.write("[");
    await fetchChunks("0x", chunksLevel, stream);
    stream.write("]");
    stream.end();
    progressBar.stop();
  }

  const metadata = await api.rpc.state.getMetadata();
  // Populate the prefixes array
  const modules = JSON.parse(metadata.asLatest.modules);
  modules.forEach((module) => {
    if (module.storage) {
      console.log("Prefix:", module.storage.prefix);
      console.log("Items:", module.storage.items);
      if (!skippedModulesPrefix.includes(module.storage.prefix)) {
        prefixes.push(xxhashAsHex(module.storage.prefix, 128));
      }
    }
  });

  // Generate chain spec for original and forked chains
  execSync(
    binaryPath + " build-spec --chain=lerna --raw > " + originalSpecPath
  );

  //If you want to create fork for development this is the setting
  //if (dev) execSync(binaryPath + " build-spec --dev --raw > " + forkedSpecPath);
  //else
  execSync(binaryPath + " build-spec --chain=lerna --raw > " + forkedSpecPath);

  let storage = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, "utf8"));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, "utf8"));

  // Modify chain name and id
  forkedSpec.name = "HydraDX Snakenet Gen3";
  if (dev) forkedSpec.id = "test";
  else forkedSpec.id = originalSpec.id;

  forkedSpec.protocolId = "hdx-gen3-1";

  // GENESIS 3

  // USE THIS TO CHANGE BOOTNODES
  // forkedSpec.bootNodes = [
  //   "/tcp/30333/p2p/12D3KooWAARuC6mZWFBBscoBs1eSmyx8kcswDgZLRowfTtVGLkzR",
  // ];

  let validators = [];
  let nominators = [];

  // Iterate through prefixes from the original chain and clear them
  Object.keys(forkedSpec.genesis.raw.top)
    .filter((i) => clearPrefixes.some((prefix) => i.startsWith(prefix)))
    .forEach((i) => delete forkedSpec.genesis.raw.top[i]);

  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  //Get list of nominators for bonus rewards
  Object.keys(forkedSpec.genesis.raw.top)
    .filter((i) =>
      i.startsWith(
        "0x5f3e4907f716ac89b6347d15ececedca9c6a637f62ae2af1c7e31eed7e96be04"
      )
    )
    .forEach((i) => {
      let nominator = api.createType("AccountId", "0x" + i.slice(-64));
      nominators.push(nominator.toHex());
    });

  //Get list of validators for bonus rewards
  Object.keys(forkedSpec.genesis.raw.top)
    .filter((i) =>
      i.startsWith(
        "0x5f3e4907f716ac89b6347d15ececedca88dcde934c658227ee1dfafcd6e16903"
      )
    )
    .forEach((i) => {
      let validator = api.createType("AccountId", "0x" + i.slice(-64));
      validators.push(validator.toHex());
    });

  // Remove Information about staking rewards as that would be in the future on the new chain
  Object.keys(forkedSpec.genesis.raw.top)
    .filter((i) =>
      i.startsWith(
        "0x5f3e4907f716ac89b6347d15ececedca422adb579f1dbf4f3886c5cfa3bb8cc4"
      )
    )
    .forEach((i) => {
      let ledger = api.createType(
        "StakingLedger",
        forkedSpec.genesis.raw.top[i]
      );
      let noHistory = api.createType("StakingLedger", {
        stash: ledger.stash,
        total: ledger.total,
        active: ledger.active,
      });

      forkedSpec.genesis.raw.top[i] = noHistory.toHex();
    });

  console.log("Creating list of", validators.length, "validators");
  console.log("Creating list of", nominators.length, "nominators");

  fs.writeFileSync("validators.json", JSON.stringify(validators, 2, 2));
  fs.writeFileSync("nominators.json", JSON.stringify(nominators, 2, 2));

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top[
    "0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8"
  ];

  // Genesis history
  forkedSpec.genesis.raw.top[
    "0x1754677a24055221d22db56f83f5e21390895d6c6b21a85c004b8942c3bc35ae"
  ] =
    "0x803d75507dd46301767e601265791da1d9cb47b6ebc94e87347b635e5bf58bd04780f2da8c357140c4900cddc37ff93df8cdee3989584bffb18074878e096f6c926c";

  //System/upgradedToTripleRefCount
  forkedSpec.genesis.raw.top[
    "0x26aa394eea5630e07c48ae0c9558cef7a7fd6c28836b9a28522dc924110cf439"
  ] = "0x01";

  //System/upgradedToU32RefCount
  forkedSpec.genesis.raw.top[
    "0x26aa394eea5630e07c48ae0c9558cef75684a022a34dd8bfa2baaf44f172b710"
  ] = "0x01";

  //Current planned session
  forkedSpec.genesis.raw.top[
    "0x5f3e4907f716ac89b6347d15ececedcac0d39ff577af2cc6b67ac3641fa9c4e7"
  ] = "0x00000000";

  //EpochConfig
  forkedSpec.genesis.raw.top[
    "0x1cb6f36e027abb2091cfb5110ab5087fdc6b171b77304263c292cc3ea5ed31ef"
  ] = "0x0100000000000000040000000000000001";

  //ActiveEra
  forkedSpec.genesis.raw.top[
    "0x5f3e4907f716ac89b6347d15ececedca487df464e44a534ba6b0cbb32407b587"
  ] = "0x0000000000";

  //SET VALIDATOR PREFS FOR INTERGALACTIC
  //VAL01
  forkedSpec.genesis.raw.top[
    "0x5f3e4907f716ac89b6347d15ececedca422adb579f1dbf4f3886c5cfa3bb8cc45c6987fcf1bc8b56c3ebdc2a55d4e55c5245cb1e9e810f66940ec82a23a485491347bdbdc2726f3e2d40d9650cbc4103"
  ] =
    "0x5245cb1e9e810f66940ec82a23a485491347bdbdc2726f3e2d40d9650cbc41030b00407a10f35a0b00407a10f35a0000";

  //VAL02
  forkedSpec.genesis.raw.top[
    "0x5f3e4907f716ac89b6347d15ececedca422adb579f1dbf4f3886c5cfa3bb8cc40401e578d3d4d3c55b5e85dceecee3e7fa431893b2d8196ab179793714d653ce840fcac1847c1cb32522496989c0e556"
  ] =
    "0xfa431893b2d8196ab179793714d653ce840fcac1847c1cb32522496989c0e5560b00407a10f35a0b00407a10f35a0000";

  //VAL03
  forkedSpec.genesis.raw.top[
    "0x5f3e4907f716ac89b6347d15ececedca422adb579f1dbf4f3886c5cfa3bb8cc473e3541920d3f9949972f798c7e470e4be72e2daa41acfd97eed4c09a086dc84b99df8e8ddddb67e90b71c36e4826378"
  ] =
    "0xbe72e2daa41acfd97eed4c09a086dc84b99df8e8ddddb67e90b71c36e48263780b00407a10f35a0b00407a10f35a0000";

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top["0x3a636f6465"] =
    "0x" + fs.readFileSync(hexPath, "utf8").trim();

  fs.writeFileSync(forkedSpecPath, JSON.stringify(forkedSpec, null, 4));

  console.log(
    "Forked genesis generated successfully. Find it at ./data/fork.json"
  );
  process.exit();
}

main();

async function fetchChunks(prefix, levelsRemaining, stream) {
  if (levelsRemaining <= 0) {
    const pairs = await provider.send("state_getPairs", [prefix]);
    if (pairs.length > 0) {
      separator ? stream.write(",") : (separator = true);
      stream.write(JSON.stringify(pairs).slice(1, -1));
    }
    progressBar.update(++chunksFetched);
    return;
  }

  // Async fetch the last level
  if (process.env.QUICK_MODE && levelsRemaining == 1) {
    let promises = [];
    for (let i = 0; i < 256; i++) {
      promises.push(
        fetchChunks(
          prefix + i.toString(16).padStart(2 * chunksLevel, "0"),
          levelsRemaining - 1,
          stream
        )
      );
    }
    await Promise.all(promises);
  } else {
    for (let i = 0; i < 256; i++) {
      await fetchChunks(
        prefix + i.toString(16).padStart(2 * chunksLevel, "0"),
        levelsRemaining - 1,
        stream
      );
    }
  }
}
