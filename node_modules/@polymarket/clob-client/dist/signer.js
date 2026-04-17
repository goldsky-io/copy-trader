const isEthersTypedDataSigner = (signer) => 
// eslint-disable-next-line no-underscore-dangle
typeof signer._signTypedData === "function";
const isWalletClientSigner = (signer) => typeof signer.signTypedData === "function";
export const getWalletClientAddress = async (walletClient) => {
    const accountAddress = walletClient.account?.address;
    if (typeof accountAddress === "string" && accountAddress.length > 0) {
        return accountAddress;
    }
    if (typeof walletClient.requestAddresses === "function") {
        const [address] = await walletClient.requestAddresses();
        if (typeof address === "string" && address.length > 0) {
            return address;
        }
    }
    if (typeof walletClient.getAddresses === "function") {
        const [address] = await walletClient.getAddresses();
        if (typeof address === "string" && address.length > 0) {
            return address;
        }
    }
    throw new Error("wallet client is missing account address");
};
export const getSignerAddress = async (signer) => {
    if (isEthersTypedDataSigner(signer)) {
        return signer.getAddress();
    }
    if (isWalletClientSigner(signer)) {
        return getWalletClientAddress(signer);
    }
    throw new Error("unsupported signer type");
};
export const signTypedDataWithSigner = async ({ signer, domain, types, value, primaryType, }) => {
    if (isEthersTypedDataSigner(signer)) {
        // eslint-disable-next-line no-underscore-dangle
        return signer._signTypedData(domain, types, value);
    }
    if (isWalletClientSigner(signer)) {
        const account = signer.account ?? (await getWalletClientAddress(signer));
        return signer.signTypedData({
            account,
            domain,
            types,
            primaryType,
            message: value,
        });
    }
    throw new Error("unsupported signer type");
};
//# sourceMappingURL=signer.js.map