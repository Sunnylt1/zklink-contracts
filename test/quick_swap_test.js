const hardhat = require('hardhat');
const { expect } = require('chai');
const {writeDepositPubdata, getQuickSwapPubdata, calFee} = require('./utils');

describe('Quick swap unit tests', function () {
    let token, zkSync, zkSyncBlock, zkSyncExit, governance, vault, pair;
    let wallet,alice,bob;
    beforeEach(async () => {
        [wallet,alice,bob,pair] = await hardhat.ethers.getSigners();
        // token
        const erc20Factory = await hardhat.ethers.getContractFactory('cache/solpp-generated-contracts/dev-contracts/ERC20.sol:ERC20');
        token = await erc20Factory.deploy(10000);
        // governance, alice is networkGovernor
        const governanceFactory = await hardhat.ethers.getContractFactory('Governance');
        governance = await governanceFactory.deploy();
        await governance.initialize(
            hardhat.ethers.utils.defaultAbiCoder.encode(['address'], [alice.address])
        );
        await governance.connect(alice).addToken(token.address); // tokenId = 1
        await governance.connect(alice).setValidator(bob.address, true); // set bob as validator
        // verifier
        const verifierFactory = await hardhat.ethers.getContractFactory('Verifier');
        const verifier = await verifierFactory.deploy();
        // Vault
        const vaultFactory = await hardhat.ethers.getContractFactory('Vault');
        vault = await vaultFactory.deploy();
        await vault.initialize(hardhat.ethers.utils.defaultAbiCoder.encode(['address'], [governance.address]));
        // ZkSync
        const contractFactory = await hardhat.ethers.getContractFactory('ZkLinkTest');
        zkSync = await contractFactory.deploy();
        // ZkSyncCommitBlock
        const zkSyncBlockFactory = await hardhat.ethers.getContractFactory('ZkLinkBlockTest');
        const zkSyncBlockRaw = await zkSyncBlockFactory.deploy();
        zkSyncBlock = zkSyncBlockFactory.attach(zkSync.address);
        // ZkSyncExit
        const zkSyncExitFactory = await hardhat.ethers.getContractFactory('ZkLinkExit');
        const zkSyncExitRaw = await zkSyncExitFactory.deploy();
        zkSyncExit = zkSyncExitFactory.attach(zkSync.address);
        await zkSync.initialize(
            hardhat.ethers.utils.defaultAbiCoder.encode(['address','address','address','address','address','bytes32'],
                [governance.address, verifier.address, vault.address, zkSyncBlockRaw.address, zkSyncExitRaw.address, hardhat.ethers.utils.arrayify("0x1b06adabb8022e89da0ddb78157da7c57a5b7356ccc9ad2f51475a4bb13970c6")])
        );
        await vault.setZkLinkAddress(zkSync.address);
    });

    it('should revert when exodusMode is active', async () => {
        await zkSync.setExodusMode(true);
        await expect(zkSync.swapExactTokensForTokens(wallet.address, 1, 0, token.address, 1, 1, wallet.address, 0, pair.address, 1, 1)).to.be.revertedWith("L");
    });

    it('should revert when swap to the same token', async () => {
        await expect(zkSync.swapExactTokensForTokens(wallet.address, 1, 0, token.address, 1, 1, wallet.address, 0, pair.address, 1, 1)).to.be.revertedWith("ZkLink: can not swap to the same token");
    });

    it('quick swap erc20 should success', async () => {
        const amountIn = hardhat.ethers.utils.parseEther("1");
        const amountOutMin = hardhat.ethers.utils.parseEther("3000");
        const toChainId = 2;
        const toTokenId = 1;
        const to = bob.address;
        const acceptTokenId = toTokenId;
        const acceptAmountOutMin = amountOutMin;
        await token.connect(bob).mint(amountIn);
        await token.connect(bob).approve(zkSync.address, amountIn);
        await zkSync.connect(bob).swapExactTokensForTokens(bob.address, amountIn, amountOutMin, token.address, toChainId, toTokenId, to, 0, pair.address, acceptTokenId, acceptAmountOutMin);
        expect(await token.balanceOf(vault.address)).equal(amountIn);
    });

    it('cancelOutstandingDepositsForExodusMode should success', async () => {
        await token.connect(bob).mint(100);
        await token.connect(bob).approve(zkSync.address, 100);
        await zkSync.connect(bob).depositERC20(token.address, 30, bob.address);
        await zkSync.connect(bob).swapExactTokensForTokens(bob.address, 20, 0, token.address, 2, 1, bob.address, 0, pair.address, 1, 1);

        const tokenId = '0x0001';
        const amount = '0x0000000000000000000000000000001e';
        const owner = bob.address;
        const pubdata0 = writeDepositPubdata({ tokenId, amount, owner });

        const fromChainId = '0x01';
        const toChainId = '0x02';
        const toTokenId = '0x0001';
        const amountIn = '0x00000000000000000000000000000014';
        const amountOutMin = '0x00000000000000000000000000000000';
        const amountOut = '0x00000000000000000000000000000000';
        const nonce = '0x00000000';
        const acceptTokenId = toTokenId;
        const acceptAmountOutMin = '0x00000000000000000000000000000001';
        const pubdata1 = getQuickSwapPubdata({ fromChainId, toChainId, owner, fromTokenId:tokenId, amountIn, to:bob.address, toTokenId, amountOutMin, amountOut, nonce, pair:pair.address, acceptTokenId, acceptAmountOutMin});
        await zkSync.setExodusMode(true);
        const b0 = await token.balanceOf(bob.address);
        await zkSyncExit.cancelOutstandingDepositsForExodusMode(3, [pubdata0, pubdata1]);
        const b1 = await token.balanceOf(bob.address);
        expect(b1.sub(b0)).to.be.equal(50);
    });

    it('accept erc20 token should success', async () => {
        // swap from eth[chain1] to eth[chain0] but user really want to receive token 1 in chain0
        const toTokenId = 0;
        const accepter = alice.address;
        const receiver = bob.address;
        const nonce = 134;
        const acceptTokenId = 1;
        const acceptAmountOutMin = hardhat.ethers.utils.parseEther("997");

        let amount = hardhat.ethers.utils.parseEther("1000");
        await token.connect(alice).mint(amount);
        await token.connect(alice).approve(zkSync.address, amount);
        const ethAmountOut = hardhat.ethers.utils.parseEther("0.995");
        await zkSyncExit.connect(alice).acceptQuickSwap(accepter, receiver, toTokenId, ethAmountOut, acceptTokenId, acceptAmountOutMin, nonce);

        expect(await token.balanceOf(alice.address)).to.eq(hardhat.ethers.utils.parseEther("3"));
        expect(await token.balanceOf(bob.address)).to.eq(acceptAmountOutMin);
    });

    it('if swap fail owner in from chain should not get token back', async () => {
        const opType = 12;
        const fromChainId = 1;
        const toChainId = 2;
        const fromTokenId = 1;
        const toTokenId = 1;
        const nonce = 134;
        const acceptTokenId = 1;
        const acceptAmountOutMin = 0;
        const amountIn = hardhat.ethers.utils.parseEther("1");
        const amountOutMin = hardhat.ethers.utils.parseEther("0.99");
        const amountOut = 0;

        const encodePubdata = hardhat.ethers.utils.solidityPack(["uint8","uint8","uint8","address","uint16","uint128","address","uint16","uint128","uint128","uint32","address","uint16","uint128"],
            [opType,fromChainId,toChainId,bob.address,fromTokenId,amountIn,bob.address,toTokenId,amountOutMin,amountOut,nonce,pair.address,acceptTokenId,acceptAmountOutMin]);
        const pubdata = ethers.utils.arrayify(encodePubdata);
        const b0 = await token.balanceOf(bob.address);
        await zkSyncBlock.testExecQuickSwap(pubdata);
        const b1 = await token.balanceOf(bob.address);
        expect(b1.sub(b0)).to.eq(0);
    });

    it('if swap success and no accepter owner in to chain should receive to token', async () => {
        const opType = 12;
        const fromChainId = 2;
        const toChainId = 1;
        const fromTokenId = 1;
        const toTokenId = 1;
        const nonce = 134;
        const acceptTokenId = 1;
        const acceptAmountOutMin = 0;
        const amountIn = hardhat.ethers.utils.parseEther("1");
        const amountOutMin = hardhat.ethers.utils.parseEther("0.99");
        const amountOut = hardhat.ethers.utils.parseEther("0.995");

        await token.mintTo(vault.address, amountIn);
        const encodePubdata = hardhat.ethers.utils.solidityPack(["uint8","uint8","uint8","address","uint16","uint128","address","uint16","uint128","uint128","uint32","address","uint16","uint128"],
            [opType,fromChainId,toChainId,bob.address,fromTokenId,amountIn,bob.address,toTokenId,amountOutMin,amountOut,nonce,pair.address,acceptTokenId,acceptAmountOutMin]);
        const pubdata = ethers.utils.arrayify(encodePubdata);
        const b0 = await token.balanceOf(bob.address);
        await zkSyncBlock.testExecQuickSwap(pubdata);
        const b1 = await token.balanceOf(bob.address);
        expect(b1.sub(b0)).to.eq(amountOut);
    });

    it('if swap success and accepter exist accepter in to chain should receive to token', async () => {
        const opType = 12;
        const fromChainId = 2;
        const toChainId = 1;
        const fromTokenId = 1;
        const toTokenId = 1;
        const nonce = 134;
        const acceptTokenId = 1;
        const acceptAmountOutMin = hardhat.ethers.utils.parseEther("0.99");
        const amountIn = hardhat.ethers.utils.parseEther("1");
        const amountOutMin = hardhat.ethers.utils.parseEther("0.99");
        const amountOut = hardhat.ethers.utils.parseEther("0.995");

        let amount = hardhat.ethers.utils.parseEther("1");
        await token.connect(alice).mint(amount);
        await token.connect(alice).approve(zkSync.address, amount);
        await zkSyncExit.connect(alice).acceptQuickSwap(alice.address, bob.address, toTokenId, amountOut, acceptTokenId, acceptAmountOutMin, nonce);

        await token.mintTo(vault.address, amountIn);
        const encodePubdata = hardhat.ethers.utils.solidityPack(["uint8","uint8","uint8","address","uint16","uint128","address","uint16","uint128","uint128","uint32","address","uint16","uint128"],
            [opType,fromChainId,toChainId,bob.address,fromTokenId,amountIn,bob.address,toTokenId,amountOutMin,amountOut,nonce,pair.address,acceptTokenId,acceptAmountOutMin]);
        const pubdata = ethers.utils.arrayify(encodePubdata);
        const b0 = await token.balanceOf(alice.address);
        await zkSyncBlock.testExecQuickSwap(pubdata);
        const b1 = await token.balanceOf(alice.address);
        expect(b1.sub(b0)).to.eq(amountOut);
    });
});
