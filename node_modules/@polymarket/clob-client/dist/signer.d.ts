import type { Address, WalletClient } from "viem";
type TypedDataDomain = Record<string, unknown>;
type TypedDataTypes = Record<string, Array<{
    name: string;
    type: string;
}>>;
type TypedDataValue = Record<string, unknown>;
interface EthersSigner {
    _signTypedData(domain: TypedDataDomain, types: TypedDataTypes, value: TypedDataValue): Promise<string>;
    getAddress(): Promise<string>;
}
export type ClobSigner = EthersSigner | WalletClient;
export declare const getWalletClientAddress: (walletClient: WalletClient) => Promise<Address>;
export declare const getSignerAddress: (signer: ClobSigner) => Promise<string>;
export declare const signTypedDataWithSigner: ({ signer, domain, types, value, primaryType, }: {
    signer: ClobSigner;
    domain: TypedDataDomain;
    types: TypedDataTypes;
    value: TypedDataValue;
    primaryType?: string;
}) => Promise<string>;
export {};
