import { BrowserNode, NonEIP712Message } from "@connext/vector-browser-node";
import {
  getPublicKeyFromPublicIdentifier,
  encrypt,
  createlockHash,
  getBalanceForAssetId,
  getRandomBytes32,
  constructRpcRequest,
} from "@connext/vector-utils";
import React, { useState } from "react";
import { constants, providers } from "ethers";
import { Col, Divider, Row, Statistic, Input, Typography, Table, Form, Button, List, Select, Tabs, Radio } from "antd";
import { CopyToClipboard } from "react-copy-to-clipboard";
import { EngineEvents, FullChannelState, jsonifyError, TransferNames } from "@connext/vector-types";

import "./App.css";
import { config } from "./config";

function App() {
  const [node, setNode] = useState<BrowserNode>();
  const [routerPublicIdentifier, setRouterPublicIdentifier] = useState<string>();
  const [channels, setChannels] = useState<FullChannelState[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<FullChannelState>();
  const [showCustomIframe, setShowCustomIframe] = useState<boolean>(false);

  const [setupLoading, setSetupLoading] = useState<boolean>(false);
  const [connectLoading, setConnectLoading] = useState<boolean>(false);
  const [depositLoading, setDepositLoading] = useState<boolean>(false);
  const [requestCollateralLoading, setRequestCollateralLoading] = useState<boolean>(false);
  const [transferLoading, setTransferLoading] = useState<boolean>(false);
  const [withdrawLoading, setWithdrawLoading] = useState<boolean>(false);

  const [connectError, setConnectError] = useState<string>();
  const [copied, setCopied] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<"HashlockTransfer" | "CrossChainTransfer">("HashlockTransfer");

  const [withdrawForm] = Form.useForm();
  const [transferForm] = Form.useForm();
  const [signMessageForm] = Form.useForm();

  const connectNode = async (
    iframeSrc: string,
    supportedChains: number[],
    _routerPublicIdentifier: string,
    loginProvider: "none" | "metamask" | "magic",
  ): Promise<BrowserNode> => {
    try {
      setConnectLoading(true);
      setRouterPublicIdentifier(_routerPublicIdentifier);
      const chainProviders = {};
      supportedChains.forEach((chain) => {
        chainProviders[chain] = config.chainProviders[chain];
      });
      const client = new BrowserNode({
        supportedChains,
        iframeSrc,
        routerPublicIdentifier: _routerPublicIdentifier,
        chainProviders,
        chainAddresses: config.chainAddresses,
        messagingUrl: config.messagingUrl,
      });
      let init: { signature?: string; signer?: string } | undefined = undefined;
      if (loginProvider === "metamask" || loginProvider === "magic") {
        let _loginProvider: providers.Web3Provider;
        if (loginProvider === "metamask") {
          _loginProvider = new providers.Web3Provider((window as any).ethereum);
          const accts = await _loginProvider.send("eth_requestAccounts", []);
          console.log("accts: ", accts);
        } else {
          throw new Error("MAGIC TODO");
        }
        const signer = _loginProvider.getSigner();
        const signerAddress = await signer.getAddress();
        console.log("signerAddress: ", signerAddress);
        const signature = await signer.signMessage(NonEIP712Message);
        console.log("signature: ", signature);
        init = { signature, signer: signerAddress };
      }

      let error: any | undefined;
      try {
        await client.init(init);
      } catch (e) {
        console.error("Error initializing Browser Node:", jsonifyError(e));
        error = e;
      }
      const shouldAttemptRestore = (error?.context?.validationError ?? "").includes("Channel is already setup");
      if (error && !shouldAttemptRestore) {
        throw new Error(`Error initializing browser node: ${error}`);
      }

      if (error && shouldAttemptRestore) {
        console.warn("Attempting restore from router");
        for (const supportedChain of supportedChains) {
          const channelRes = await client.getStateChannelByParticipants({
            counterparty: _routerPublicIdentifier,
            chainId: supportedChain,
          });
          if (channelRes.isError) {
            throw channelRes.getError();
          }
          if (!channelRes.getValue()) {
            const restoreChannelState = await client.restoreState({
              counterpartyIdentifier: _routerPublicIdentifier,
              chainId: supportedChain,
            });
            if (restoreChannelState.isError) {
              console.error("Could not restore state");
              throw restoreChannelState.getError();
            }
            console.log("Restored state: ", restoreChannelState.getValue());
          }
        }
        console.warn("Restore complete, re-initing");
        await client.init(init);
      }

      const channelsRes = await client.getStateChannels();
      if (channelsRes.isError) {
        setConnectError(channelsRes.getError().message);
        return;
      }
      const channelAddresses = channelsRes.getValue();
      const _channels = (
        await Promise.all(
          channelAddresses.map(async (c) => {
            const channelRes = await client.getStateChannel({ channelAddress: c });
            console.log("Channel found in store:", channelRes.getValue());
            const channelVal = channelRes.getValue() as FullChannelState;
            return channelVal;
          }),
        )
      ).filter((chan) => supportedChains.includes(chan.networkContext.chainId));
      if (_channels.length > 0) {
        setChannels(_channels);
        setSelectedChannel(_channels[0]);
      }
      setNode(client);
      client.on(EngineEvents.DEPOSIT_RECONCILED, async (data) => {
        console.log("Received EngineEvents.DEPOSIT_RECONCILED: ", data);
        await updateChannel(client, data.channelAddress);
      });

      client.on(EngineEvents.CONDITIONAL_TRANSFER_CREATED, async (data) => {
        console.log("Received EngineEvents.CONDITIONAL_TRANSFER_CREATED: ", data);
        if (data.transfer.responder !== client.signerAddress) {
          console.log("We are not the responder");
          return;
        }
        if (!data.transfer.meta?.encryptedPreImage) {
          console.log("No encrypted preImage attached", data.transfer);
          return;
        }
        const rpc = constructRpcRequest<"chan_decrypt">("chan_decrypt", data.transfer.meta.encryptedPreImage);
        const decryptedPreImage = await client.send(rpc);

        const requestRes = await client.resolveTransfer({
          channelAddress: data.transfer.channelAddress,
          transferResolver: {
            preImage: decryptedPreImage,
          },
          transferId: data.transfer.transferId,
        });
        if (requestRes.isError) {
          console.error("Error resolving transfer", requestRes.getError());
        }
        await updateChannel(client, data.channelAddress);
      });
      return client;
    } catch (e) {
      console.error("Error connecting node: ", e);
      setConnectError(e.message);
    } finally {
      setConnectLoading(false);
    }
  };

  const reconnectNode = async (
    supportedChains: number[],
    iframeSrc = "http://localhost:3030",
    _routerPublicIdentifier = "vector8Uz1BdpA9hV5uTm6QUv5jj1PsUyCH8m8ciA94voCzsxVmrBRor",
  ) => {
    setRouterPublicIdentifier(_routerPublicIdentifier);
    setConnectLoading(true);
    try {
      const chainProviders = {};
      supportedChains.forEach((chainId) => {
        chainProviders[chainId.toString()] = config.chainProviders[chainId.toString()];
      });
      console.error("creating new browser node on", supportedChains, "with providers", chainProviders);
      const client = new BrowserNode({
        supportedChains,
        iframeSrc,
        routerPublicIdentifier: _routerPublicIdentifier,
        chainProviders,
      });
      await client.init();
      setNode(client);
    } catch (e) {
      setConnectError(e.message);
    }
    setConnectLoading(false);
  };

  const updateChannel = async (node: BrowserNode, channelAddress: string) => {
    const res = await node.getStateChannel({ channelAddress });
    if (res.isError) {
      console.error("Error getting state channel", res.getError());
    } else {
      console.log("Updated channel:", res.getValue());
      const idx = channels.findIndex((c) => c.channelAddress === channelAddress);
      channels.splice(idx, 0, res.getValue());
      setChannels(channels);
    }
  };

  const setupChannel = async (aliceIdentifier: string, chainId: number) => {
    setSetupLoading(true);
    const setupRes = await node.setup({
      counterpartyIdentifier: aliceIdentifier,
      chainId,
      timeout: "100000",
    });
    if (setupRes.isError) {
      console.error(setupRes.getError());
    } else {
      channels.push(setupRes.getValue() as FullChannelState);
      setChannels(channels);
    }
    setSetupLoading(false);
  };

  const reconcileDeposit = async (assetId: string) => {
    setDepositLoading(true);
    const depositRes = await node.reconcileDeposit({
      channelAddress: selectedChannel.channelAddress,
      assetId,
    });
    if (depositRes.isError) {
      console.error("Error depositing", depositRes.getError());
    }
    setDepositLoading(false);
  };

  const requestCollateral = async (assetId: string) => {
    setRequestCollateralLoading(true);
    const requestRes = await node.requestCollateral({
      channelAddress: selectedChannel.channelAddress,
      assetId,
    });
    if (requestRes.isError) {
      console.error("Error depositing", requestRes.getError());
    }
    setRequestCollateralLoading(false);
  };

  const transfer = async (assetId: string, amount: string, recipient: string, preImage: string) => {
    setTransferLoading(true);

    const submittedMeta: { encryptedPreImage?: string } = {};
    if (recipient) {
      const recipientPublicKey = getPublicKeyFromPublicIdentifier(recipient);
      const encryptedPreImage = await encrypt(preImage, recipientPublicKey);
      submittedMeta.encryptedPreImage = encryptedPreImage;
    }

    const requestRes = await node.conditionalTransfer({
      type: TransferNames.HashlockTransfer,
      channelAddress: selectedChannel.channelAddress,
      assetId,
      amount,
      recipient,
      details: {
        lockHash: createlockHash(preImage),
        expiry: "0",
      },
      meta: submittedMeta,
    });
    if (requestRes.isError) {
      console.error("Error hashlock transferring", requestRes.getError());
    }
    setTransferLoading(false);
  };

  const withdraw = async (assetId: string, amount: string, recipient: string) => {
    setWithdrawLoading(true);
    const requestRes = await node.withdraw({
      channelAddress: selectedChannel.channelAddress,
      assetId,
      amount,
      recipient,
    });
    if (requestRes.isError) {
      console.error("Error withdrawing", requestRes.getError());
    }
    setWithdrawLoading(false);
  };

  const signMessage = async (message: string): Promise<string> => {
    const requestRes = await node.signUtilityMessage({
      message,
    });
    if (requestRes.isError) {
      console.error("Error withdrawing", requestRes.getError());
      return requestRes.getError().message;
    }
    return requestRes.getValue().signedMessage;
  };

  const onFinishFailed = (errorInfo: any) => {
    console.log("Failed:", errorInfo);
  };

  return (
    <div style={{ margin: 36 }}>
      <Row gutter={16}>
        <Col span={16}>
          <Typography.Title>Vector Browser Node</Typography.Title>
        </Col>
      </Row>
      <Divider orientation="left">Connection</Divider>
      <Row gutter={16}>
        {node?.publicIdentifier ? (
          <>
            <Col span={16}>
              <List
                itemLayout="horizontal"
                dataSource={[
                  { title: "Public Identifier", description: node!.publicIdentifier },
                  { title: "Signer Address", description: node!.signerAddress },
                ]}
                renderItem={(item) => (
                  <List.Item>
                    <List.Item.Meta title={item.title} description={item.description} />
                  </List.Item>
                )}
              />
            </Col>
            <Col span={18}>
              <Form
                layout="horizontal"
                name="reconnect"
                wrapperCol={{ span: 18 }}
                labelCol={{ span: 6 }}
                onFinish={(vals) => {
                  const iframe = showCustomIframe ? vals.customIframe : vals.iframeSrc;
                  console.log("Connecting to iframe at: ", iframe);
                  reconnectNode(
                    vals.supportedChains.split(",").map((x: string) => parseInt(x.trim())),
                    iframe,
                    vals.routerPublicIdentifier,
                  );
                }}
                initialValues={{
                  iframeSrc: "http://localhost:3030",
                  routerPublicIdentifier: "vector8Uz1BdpA9hV5uTm6QUv5jj1PsUyCH8m8ciA94voCzsxVmrBRor",
                  supportedChains: "1337,1338",
                }}
              >
                <Form.Item label="IFrame Src" name="iframeSrc">
                  <Select
                    onChange={(event) => {
                      if (event === "custom") {
                        setShowCustomIframe(true);
                      } else {
                        setShowCustomIframe(false);
                      }
                    }}
                  >
                    <Select.Option value="http://localhost:3030">http://localhost:3030</Select.Option>
                    <Select.Option value="https://wallet.connext.network">https://wallet.connext.network</Select.Option>
                    <Select.Option value="custom">Custom</Select.Option>
                  </Select>
                </Form.Item>

                {showCustomIframe && (
                  <Form.Item label="Custom Iframe URL" name="customIframe">
                    <Input />
                  </Form.Item>
                )}

                <Form.Item name="routerPublicIdentifier" label="Router Public Identifier">
                  <Input placeholder="vector..." />
                </Form.Item>

                <Form.Item name="supportedChains" label="Supported Chains">
                  <Input placeholder="Chain Ids (domma-separated)" />
                </Form.Item>

                <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
                  <Button type="primary" htmlType="submit" loading={connectLoading}>
                    Reconnect To Iframe
                  </Button>
                </Form.Item>
              </Form>
            </Col>
          </>
        ) : connectError ? (
          <>
            <Col span={16}>
              <Statistic title="Error Connecting Node" value={connectError} />
            </Col>
          </>
        ) : (
          <Col span={18}>
            <Form
              layout="horizontal"
              name="node"
              wrapperCol={{ span: 18 }}
              labelCol={{ span: 6 }}
              onFinish={(vals) => {
                const iframe = showCustomIframe ? vals.customIframe : vals.iframeSrc;
                console.log("Connecting to iframe at: ", iframe);
                connectNode(
                  iframe,
                  vals.supportedChains.split(",").map((x: string) => parseInt(x.trim())),
                  vals.routerPublicIdentifier,
                  vals.loginProvider,
                );
              }}
              initialValues={{
                iframeSrc: "http://localhost:3030",
                routerPublicIdentifier: "vector8Uz1BdpA9hV5uTm6QUv5jj1PsUyCH8m8ciA94voCzsxVmrBRor",
                supportedChains: "1337,1338",
                loginProvider: "none",
              }}
            >
              <Form.Item label="IFrame Src" name="iframeSrc">
                <Select
                  onChange={(event) => {
                    if (event === "custom") {
                      setShowCustomIframe(true);
                    } else {
                      setShowCustomIframe(false);
                    }
                  }}
                >
                  <Select.Option value="http://localhost:3030">http://localhost:3030</Select.Option>
                  <Select.Option value="https://wallet.connext.network">https://wallet.connext.network</Select.Option>
                  <Select.Option value="custom">Custom</Select.Option>
                </Select>
              </Form.Item>

              {showCustomIframe && (
                <Form.Item label="Custom Iframe URL" name="customIframe">
                  <Input />
                </Form.Item>
              )}

              <Form.Item name="routerPublicIdentifier" label="Router Public Identifier">
                <Input placeholder="vector..." />
              </Form.Item>

              <Form.Item name="supportedChains" label="Supported Chains">
                <Input placeholder="Chain Ids (domma-separated)" />
              </Form.Item>

              <Form.Item name="loginProvider" label="Login Provider">
                <Radio.Group>
                  <Radio value="none">None</Radio>
                  <Radio value="metamask">Metamask</Radio>
                  <Radio value="magic">Magic.Link</Radio>
                </Radio.Group>
              </Form.Item>

              <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
                <Button type="primary" htmlType="submit" loading={connectLoading}>
                  Connect To Iframe
                </Button>
              </Form.Item>
            </Form>
          </Col>
        )}
      </Row>
      {node?.publicIdentifier && (
        <>
          <Divider orientation="left">Setup Channel</Divider>
          <Row gutter={16}>
            <Col span={18}>
              <Form
                layout="horizontal"
                name="setup"
                wrapperCol={{ span: 18 }}
                labelCol={{ span: 6 }}
                onFinish={(vals) => setupChannel(vals.counterparty, parseInt(vals.chainId))}
              >
                <Form.Item
                  label="Counterparty"
                  name="counterparty"
                  rules={[{ required: true, message: "Please input the counterparty identifier!" }]}
                >
                  <Input placeholder="Counterparty Identifier" />
                </Form.Item>

                <Form.Item
                  label="Chain Id"
                  name="chainId"
                  rules={[{ required: true, message: "Please input the chain ID!" }]}
                >
                  <Input placeholder="Chain Id" />
                </Form.Item>

                <Form.Item wrapperCol={{ offset: 8, span: 16 }}>
                  <Button type="primary" htmlType="submit" loading={setupLoading}>
                    Setup Channel
                  </Button>
                </Form.Item>
              </Form>
            </Col>
          </Row>

          <Divider orientation="left">Channels</Divider>
          <Row gutter={16}>
            <Col span={12}>
              <Form layout="horizontal" name="selectChannel" wrapperCol={{ span: 18 }} labelCol={{ span: 6 }}>
                <Form.Item label="Channels">
                  <Select
                    value={selectedChannel?.channelAddress}
                    onChange={(newChannel) => {
                      const c = channels.find((chan) => chan.channelAddress === newChannel);
                      setSelectedChannel(c);
                    }}
                  >
                    {channels.map((channel) => (
                      <Select.Option value={channel.channelAddress} key={channel.channelAddress}>
                        {channel.channelAddress}
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              </Form>
            </Col>
            <Col span={2}>
              <CopyToClipboard
                text={selectedChannel?.channelAddress}
                onCopy={() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 5000);
                }}
              >
                <Button>{copied ? "Copied!" : "Copy"}</Button>
              </CopyToClipboard>
            </Col>
            <Col span={6}>ChainId: {selectedChannel?.networkContext.chainId}</Col>
          </Row>

          <Divider orientation="left">Balance & Deposit</Divider>
          <Row gutter={16}>
            {selectedChannel && selectedChannel.assetIds && (
              <Col span={24}>
                <Table
                  dataSource={selectedChannel.assetIds.map((assetId, index) => {
                    return {
                      key: index,
                      assetId,
                      counterpartyBalance: selectedChannel.balances[index].amount[0], // they are Alice
                      myBalance: selectedChannel.balances[index].amount[1], // we are Bob
                    };
                  })}
                  columns={[
                    {
                      title: "Asset ID",
                      dataIndex: "assetId",
                      key: "assetId",
                    },
                    {
                      title: "My Balance",
                      dataIndex: "myBalance",
                      key: "myBalance",
                    },
                    {
                      title: "Counterparty Balance",
                      dataIndex: "counterpartyBalance",
                      key: "counterpartyBalance",
                    },
                  ]}
                />
              </Col>
            )}
          </Row>
          <div style={{ paddingTop: 24 }} />
          <Row gutter={16}>
            <Col span={24}>
              <Form layout="horizontal" name="deposit" wrapperCol={{ span: 18 }} labelCol={{ span: 6 }}>
                <Form.Item label="Reconcile Deposit">
                  <Input.Search
                    placeholder={constants.AddressZero}
                    enterButton="Reconcile"
                    suffix="Asset ID"
                    onSearch={(assetId) => reconcileDeposit(assetId || constants.AddressZero)}
                    loading={depositLoading}
                  />
                </Form.Item>
                <Form.Item label="Request Collateral">
                  <Input.Search
                    placeholder={constants.AddressZero}
                    enterButton="Request"
                    suffix="Asset ID"
                    onSearch={(assetId) => requestCollateral(assetId || constants.AddressZero)}
                    loading={requestCollateralLoading}
                  />
                </Form.Item>
              </Form>
            </Col>
          </Row>

          <Divider orientation="left">Transfer</Divider>
          <Row gutter={16}>
            <Col span={24}>
              <Tabs defaultActiveKey={activeTab} onChange={(active) => setActiveTab(active as any)}>
                <Tabs.TabPane tab="Hashlock Transfer" key="HashlockTransfer">
                  <Form
                    layout="horizontal"
                    labelCol={{ span: 6 }}
                    wrapperCol={{ span: 18 }}
                    name="transfer"
                    initialValues={{
                      assetId: selectedChannel?.assetIds && selectedChannel?.assetIds[0],
                      preImage: getRandomBytes32(),
                      numLoops: 1,
                    }}
                    onFinish={(values) => transfer(values.assetId, values.amount, values.recipient, values.preImage)}
                    onFinishFailed={onFinishFailed}
                    form={transferForm}
                  >
                    <Form.Item label="Asset ID" name="assetId">
                      <Input placeholder={constants.AddressZero} />
                      {/* <Select>
                    {channel?.assetIds?.map(aid => {
                      return (
                        <Select.Option key={aid} value={aid}>
                          {aid}
                        </Select.Option>
                      );
                    })}
                  </Select> */}
                    </Form.Item>

                    <Form.Item
                      label="Recipient"
                      name="recipient"
                      rules={[
                        { required: activeTab === "HashlockTransfer", message: "Please input recipient address" },
                      ]}
                    >
                      <Input />
                    </Form.Item>

                    <Form.Item
                      label="Amount"
                      name="amount"
                      rules={[{ required: true, message: "Please input transfer amount" }]}
                    >
                      <Input.Search
                        enterButton="MAX"
                        onSearch={() => {
                          const assetId = transferForm.getFieldValue("assetId");
                          const amount = getBalanceForAssetId(selectedChannel, assetId, "bob");
                          transferForm.setFieldsValue({ amount });
                        }}
                      />
                    </Form.Item>

                    <Form.Item
                      label="Pre Image"
                      name="preImage"
                      rules={[{ required: true, message: "Please input pre image" }]}
                    >
                      <Input.Search
                        enterButton="Random"
                        onSearch={() => {
                          const preImage = getRandomBytes32();
                          transferForm.setFieldsValue({ preImage });
                        }}
                      />
                    </Form.Item>

                    <Form.Item label="Recipient Chain ID" name="recipientChainId">
                      <Input />
                    </Form.Item>

                    <Form.Item label="Recipient Asset ID" name="recipientAssetId">
                      <Input />
                    </Form.Item>

                    <Form.Item label="Transfer Fee" name="transferFee">
                      <Input disabled />
                    </Form.Item>

                    <Form.Item label="Withdrawal Fee" name="withdrawalFee">
                      <Input disabled />
                    </Form.Item>

                    <Form.Item wrapperCol={{ offset: 6, span: 16 }}>
                      <Button
                        onClick={async () => {
                          const values = transferForm.getFieldsValue();
                          console.log("Calculating fees: ", values);
                          const transferFee = await node.getTransferQuote({
                            amount: values.amount,
                            assetId: values.assetId,
                            chainId: selectedChannel?.networkContext.chainId,
                            routerIdentifier: routerPublicIdentifier,
                            recipient: values.recipient,
                            recipientAssetId: values.recipientAssetId || undefined,
                            recipientChainId:
                              values.recipientChainId === "" ? undefined : parseInt(values.recipientChainId),
                          });
                          console.log(
                            "transferFee: ",
                            transferFee.isError ? transferFee.getError() : transferFee.getValue(),
                          );

                          const withdrawalFee = await node.getWithdrawalQuote({
                            amount: values.amount,
                            assetId: values.assetId,
                            channelAddress: selectedChannel?.channelAddress,
                          });
                          console.log(
                            "withdrawalFee: ",
                            withdrawalFee.isError ? withdrawalFee.getError() : withdrawalFee.getValue(),
                          );

                          if (!transferFee.isError && !withdrawalFee.isError) {
                            transferForm.setFieldsValue({
                              transferFee: transferFee.getValue().fee,
                              withdrawalFee: withdrawalFee.getValue().fee,
                            });
                          }
                        }}
                      >
                        Calculate Fees
                      </Button>

                      <Button type="primary" htmlType="submit" loading={transferLoading}>
                        Transfer
                      </Button>
                    </Form.Item>
                  </Form>
                </Tabs.TabPane>
              </Tabs>
            </Col>
          </Row>

          <Divider orientation="left">Withdraw</Divider>
          <Row gutter={16}>
            <Col span={24}>
              <Form
                layout="horizontal"
                labelCol={{ span: 6 }}
                wrapperCol={{ span: 18 }}
                name="withdraw"
                initialValues={{
                  assetId: selectedChannel?.assetIds && selectedChannel?.assetIds[0],
                  recipient: selectedChannel?.bob,
                }}
                onFinish={(values) => withdraw(values.assetId, values.amount, values.recipient)}
                onFinishFailed={onFinishFailed}
                form={withdrawForm}
              >
                <Form.Item label="Asset ID" name="assetId">
                  <Input placeholder={constants.AddressZero} />
                  {/* <Select>
                    {channel?.assetIds?.map(aid => {
                      return (
                        <Select.Option key={aid} value={aid}>
                          {aid}
                        </Select.Option>
                      );
                    })}
                  </Select> */}
                </Form.Item>

                <Form.Item
                  label="Recipient"
                  name="recipient"
                  rules={[{ required: true, message: "Please input recipient address" }]}
                >
                  <Input />
                </Form.Item>

                <Form.Item
                  label="Amount"
                  name="amount"
                  rules={[{ required: true, message: "Please input withdrawal amount" }]}
                >
                  <Input.Search
                    enterButton="MAX"
                    onSearch={() => {
                      const assetId = withdrawForm.getFieldValue("assetId");
                      const amount = getBalanceForAssetId(selectedChannel, assetId, "bob");
                      withdrawForm.setFieldsValue({ amount });
                    }}
                  />
                </Form.Item>

                <Form.Item wrapperCol={{ offset: 6 }}>
                  <Button type="primary" htmlType="submit" loading={withdrawLoading}>
                    Withdraw
                  </Button>
                </Form.Item>
              </Form>
            </Col>
          </Row>
          <Divider orientation="left">Withdraw</Divider>
          <Row gutter={16}>
            <Col span={24}>
              <Form
                layout="horizontal"
                labelCol={{ span: 6 }}
                wrapperCol={{ span: 18 }}
                name="signMessage"
                onFinish={async (values) => {
                  const signedMessage = await signMessage(values.message);
                  signMessageForm.setFieldsValue({ signedMessage });
                }}
                onFinishFailed={onFinishFailed}
                form={signMessageForm}
              >
                <Form.Item
                  label="Message"
                  name="message"
                  rules={[{ required: true, message: "Please input message to sign" }]}
                >
                  <Input placeholder="Text goes here" />
                </Form.Item>

                <Form.Item label="Signed Message" name="signedMessage">
                  <span />
                </Form.Item>

                <Form.Item wrapperCol={{ offset: 6 }}>
                  <Button type="primary" htmlType="submit">
                    Sign
                  </Button>
                </Form.Item>
              </Form>
            </Col>
          </Row>
        </>
      )}
    </div>
  );
}

export default App;
