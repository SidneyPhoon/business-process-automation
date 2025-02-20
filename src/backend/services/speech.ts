import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { BpaServiceObject } from '../engine/types'
import { BlobServiceClient, ContainerClient, BlockBlobClient, ContainerGenerateSasUrlOptions, ContainerSASPermissions } from "@azure/storage-blob"

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
import { CosmosDB } from "./cosmosdb";


export class Speech {

    private _client: sdk.SpeechConfig
    private _blobServiceClient: BlobServiceClient
    private _blobContainerClient: ContainerClient
    private _cosmosDb: CosmosDB

    constructor(subscriptionKey: string, region: string, connectionString: string, containerName: string, cosmosConnectionString: string, cosmosDb: string, cosmosContainer: string) {
        this._client = sdk.SpeechConfig.fromSubscription(subscriptionKey, region)
        this._client.setProfanity(sdk.ProfanityOption.Raw)
        this._blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
        this._blobContainerClient = this._blobServiceClient.getContainerClient(containerName);
        this._cosmosDb = new CosmosDB(cosmosConnectionString, cosmosDb, cosmosContainer)
    }

    private _delay = (ms: number) => {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    public processBatch = async (input: BpaServiceObject, index: number): Promise<BpaServiceObject> => {

        console.log("kicking off stt batch.......")

        const options: ContainerGenerateSasUrlOptions = {
            permissions: ContainerSASPermissions.parse("r"),
            expiresOn: new Date(new Date().valueOf() + (1000 * 60 * 60 * 24)),
        }
        const filename = input.filename.replace("documents/", "")

        let httpResult = 429
        let axiosResp: AxiosResponse
        while (httpResult === 429) {
            try {
                const blobClient: BlockBlobClient = this._blobContainerClient.getBlockBlobClient(filename) // can throw 429
                const sasUrl = await blobClient.generateSasUrl(options)
                let payload = {
                    "contentUrls": [
                        sasUrl
                    ],
                    "properties": {
                        "wordLevelTimestampsEnabled": true
                    },
                    "locale": "en-US",
                    "displayName": "Transcription of file using default model for en-US"
                }
                if (input?.serviceSpecificConfig?.to) {
                    payload = {
                        "contentUrls": [
                            sasUrl
                        ],
                        "properties": {
                            "wordLevelTimestampsEnabled": true
                        },
                        "locale": input.serviceSpecificConfig.to,
                        "displayName": "Transcription of file using default model for en-US"
                    }
                }
                const axiosParams: AxiosRequestConfig = {
                    headers: {
                        "Content-Type": "application/json",
                        "Ocp-Apim-Subscription-Key": process.env.SPEECH_SUB_KEY
                    }
                }
                axiosResp = await axios.post(process.env.SPEECH_SUB_ENDPOINT + 'speechtotext/v3.0/transcriptions', payload, axiosParams)
                httpResult = axiosResp.status
            } catch (err) {
                if (err.response.status === 429) {
                    httpResult = err.response.status
                    console.log('429.1')
                    await this._delay(5000)
                } else {
                    throw new Error(err)
                }
            }
        }
        input.aggregatedResults["speechToText"] = {
            location: axiosResp.headers.location,
            stage: "stt",
            filename: input.filename
        }

        return {
            index: index,
            type: "async transaction",
            label: input.label,
            filename: input.filename,
            pipeline: input.pipeline,
            bpaId: input.bpaId,
            aggregatedResults: input.aggregatedResults,
            resultsIndexes: input.resultsIndexes
        }
    }

    public process = (input: BpaServiceObject, index: number): Promise<BpaServiceObject> => {

        console.log("kicking off stt .......")
        return new Promise<BpaServiceObject>((resolve, reject) => {
            try {

                if (input?.serviceSpecificConfig?.to) {
                    this._client.speechRecognitionLanguage = input.serviceSpecificConfig.to
                }
                let audioConfig = sdk.AudioConfig.fromWavFileInput(input.data);
                let speechRecognizer = new sdk.SpeechRecognizer(this._client, audioConfig);

                let out = ""
                speechRecognizer.recognizing = (s, e) => {
                    //console.log(`RECOGNIZING: Text=${e.result.text}`);
                };

                speechRecognizer.recognized = (s, e) => {
                    if (e.result.reason == sdk.ResultReason.RecognizedSpeech) {
                        //console.log(`RECOGNIZED: Text=${e.result.text}`);
                        out += e.result.text + " "
                    }
                    else if (e.result.reason == sdk.ResultReason.NoMatch) {
                        console.log("NOMATCH: Speech could not be recognized.");
                    }
                };

                speechRecognizer.canceled = (s, e) => {
                    console.log(`CANCELED: Reason=${e.reason}`);

                    if (e.reason === sdk.CancellationReason.Error) {
                        console.log(`"CANCELED: ErrorCode=${e.errorCode}`);
                        console.log(`"CANCELED: ErrorDetails=${e.errorDetails}`);
                        console.log("CANCELED: Did you set the speech resource key and region values?");
                        reject(new Error(e.errorDetails))
                    }


                    //speechRecognizer.stopContinuousRecognitionAsync();
                };

                speechRecognizer.sessionStopped = (s, e) => {
                    console.log("\n    Session stopped event.");
                    speechRecognizer.stopContinuousRecognitionAsync();
                    const results = input.aggregatedResults
                    results["speechToText"] = out
                    input.resultsIndexes.push({ index: index, name: "speechToText", type: "text" })
                    resolve({
                        data: out,
                        label: "speechToText",
                        bpaId: input.bpaId,
                        type: 'text',
                        filename: input.filename,
                        pipeline: input.pipeline,
                        aggregatedResults: results,
                        resultsIndexes: input.resultsIndexes
                    })
                };


                speechRecognizer.startContinuousRecognitionAsync();
            } catch (err) {
                console.log(err)
                reject(new Error(err.message))
            }
        })
    }


}
