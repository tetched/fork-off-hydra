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
  "0x1cb6f36e027abb2091cfb5110ab5087f5e0621c4869aa60c02be9adcc98a0d1d", // Babe/Authorities // DISABLE FOR TESTNET
  "0x1cb6f36e027abb2091cfb5110ab5087faacf00b9b41fda7a9268821c2a2b3e4c", // Babe/NextAuthorities // DISABLE FOR TESTNET
  "0x5f3e4907f716ac89b6347d15ececedca3ed14b45ed20d054f05e37e2542cfe70", // Staking/Bonded
  "0x5f3e4907f716ac89b6347d15ececedca88dcde934c658227ee1dfafcd6e16903", // Staking/Validators // DISABLE FOR TESTNET
  "0x5f3e4907f716ac89b6347d15ececedca138e71612491192d68deab7e6f563fe1", // Staking/ValidatorCount
  "0x5f3e4907f716ac89b6347d15ececedca308ce9615de0775a82f8a94dc3d285a1", // Staking/StorageVersion
  "0x5f3e4907f716ac89b6347d15ececedca9220e172bed316605f73f1ff7b4ade98", // Staking/Payee
  "0x5f3e4907f716ac89b6347d15ececedca9c6a637f62ae2af1c7e31eed7e96be04", // Staking/Nominators
  "0x5f3e4907f716ac89b6347d15ececedcab49a2738eeb30896aacb8b3fb46471bd", // Staking/MinimumValidatorCount // DISABLE FOR TESTNET
];

// CLEAR storage maps from forked spec (useful for clearing data if using running chain as a base)
let clearPrefixes = [
  "0x5f3e4907f716ac89b6347d15ececedca88dcde934c658227ee1dfafcd6e16903", // Staking/Validators
  "0x5f3e4907f716ac89b6347d15ececedca3ed14b45ed20d054f05e37e2542cfe70", // Staking/Bonded
  "0x5f3e4907f716ac89b6347d15ececedca80cc6574281671b299c1727d7ac68cab", // Staking/ErasRewardsPoints
  "0x5f3e4907f716ac89b6347d15ececedca8bde0a0ea8864605e3b68ed9cb2da01b", // Staking/ErasStakers
  "0x5f3e4907f716ac89b6347d15ececedca42982b9d6c7acc99faa9094c912372c2", // Staking/ErasStakersClipped
  "0x5f3e4907f716ac89b6347d15ececedcaa141c4fe67c2d11f4a10c6aca7a79a04", // Staking/ErasTotalStake
  "0x5f3e4907f716ac89b6347d15ececedca682db92dde20a10d96d00ff0e9e221c0", // Staking/ErasValidatorPrefs
  "0x5f3e4907f716ac89b6347d15ececedca422adb579f1dbf4f3886c5cfa3bb8cc4", // Staking/Ledger
  "0x5f3e4907f716ac89b6347d15ececedca9220e172bed316605f73f1ff7b4ade98", // Staking/Payee
  "0x5f3e4907f716ac89b6347d15ececedca9c6a637f62ae2af1c7e31eed7e96be04", // Staking/Nominators
  "0x5f3e4907f716ac89b6347d15ececedcaad6e15ee7bfd5d55eba1012487d3af54", // Staking/ValidatorSlashInEra
  "0xd5c41b52a371aa36c9254ce34324f2a560dc8ef000cdbdc859dd352229ce16fb", // Offences/ConcurrentReportsIndex
  "0xd5c41b52a371aa36c9254ce34324f2a53589c0dac50da6fb3a3611eb32bcd27e", // Offences/ReportsByKindIndex
  "0xd5c41b52a371aa36c9254ce34324f2a5b262e9238fa402540c250bc3f5d6188d", // Offences/Reports
];

const skippedModulesPrefix = [
  "Authorship",
  "System",
  "Staking",
  "Babe",
  "Grandpa",
  "ImOnline",
  "PhragmenElection",
  "ElectionProviderMultiPhase",
  "Treasury",
  "GrandpaFinality",
  "FinalityTracker",
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

  if (dev) execSync(binaryPath + " build-spec --dev --raw > " + forkedSpecPath);
  else
    execSync(
      binaryPath + " build-spec --chain=lerna --raw > " + forkedSpecPath
    );

  let storage = JSON.parse(fs.readFileSync(storagePath, "utf8"));
  let originalSpec = JSON.parse(fs.readFileSync(originalSpecPath, "utf8"));
  let forkedSpec = JSON.parse(fs.readFileSync(forkedSpecPath, "utf8"));

  // Modify chain name and id
  forkedSpec.name = "HydraDX Snakenet Gen3";
  if (dev) forkedSpec.id = "test";
  else forkedSpec.id = originalSpec.id;

  forkedSpec.protocolId = "hdx-gen3";

  forkedSpec.bootNodes = [
    "/dns/p2p-01.snakenet.hydradx.io/tcp/30333/p2p/12D3KooWAJ8t7rsWvV7d1CRCT7afwtmBQBrRT7mMNDVCWK7n9CrD",
    "/dns/p2p-02.snakenet.hydradx.io/tcp/30333/p2p/12D3KooWErP8DjDoVFjsCCzvD9mFZBA6Y1VKMEBNH8vKCWDZDHz5",
    "/dns/p2p-03.snakenet.hydradx.io/tcp/30333/p2p/12D3KooWH9rsDFq3wo13eKR5PWCvEDieK8uUKd1C1dLQNNxeU5AU",
  ];

  // Iterate through prefixes and clear them
  Object.keys(forkedSpec.genesis.raw.top)
    .filter((i) => clearPrefixes.some((prefix) => i.startsWith(prefix)))
    .forEach((i) => delete forkedSpec.genesis.raw.top[i]);

  // Grab the items to be moved, then iterate through and insert into storage
  storage
    .filter((i) => prefixes.some((prefix) => i[0].startsWith(prefix)))
    .forEach(([key, value]) => (forkedSpec.genesis.raw.top[key] = value));

  // Delete System.LastRuntimeUpgrade to ensure that the on_runtime_upgrade event is triggered
  delete forkedSpec.genesis.raw.top[
    "0x26aa394eea5630e07c48ae0c9558cef7f9cce9c888469bb1a0dceaa129672ef8"
  ];

  // Set the code to the current runtime code
  forkedSpec.genesis.raw.top["0x3a636f6465"] =
    "0x" + fs.readFileSync(hexPath, "utf8").trim();

  // HydraDX Snakenet Gen3

  // Genesis history
  forkedSpec.genesis.raw.top[
    "0x1754677a24055221d22db56f83f5e21390895d6c6b21a85c004b8942c3bc35ae"
  ] =
    "0x803d75507dd46301767e601265791da1d9cb47b6ebc94e87347b635e5bf58bd04780f2da8c357140c4900cddc37ff93df8cdee3989584bffb18074878e096f6c926c";

  //RefCount
  forkedSpec.genesis.raw.top[
    "0x26aa394eea5630e07c48ae0c9558cef7c21aab032aaa6e946ca50ad39ab66603"
  ] = "0x01";

  //Session index
  forkedSpec.genesis.raw.top[
    "0xcec5070d609dd3497f72bde07fc96ba072763800a36a99fdfc7c10f6415f6ee6"
  ] = "0x00000000";

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

  //DisabledValidators
  forkedSpec.genesis.raw.top[
    "0xcec5070d609dd3497f72bde07fc96ba05a9a74be4a5a7df60b01a6c0326c5e20"
  ] = "0x00";

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
