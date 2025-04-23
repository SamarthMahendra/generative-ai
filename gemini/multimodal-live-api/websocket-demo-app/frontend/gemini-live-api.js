class GeminiLiveResponseMessage {
    constructor(data) {
        this.data = "";
        this.type = "";
        this.endOfTurn = data?.serverContent?.turnComplete;

        const parts = data?.serverContent?.modelTurn?.parts;

        if (data?.setupComplete) {
            this.type = "SETUP COMPLETE";
        } else if (parts?.length && parts[0].text) {
            this.data = parts[0].text;
            this.type = "TEXT";
        } else if (parts?.length && parts[0].inlineData) {
            this.data = parts[0].inlineData.data;
            this.type = "AUDIO";
        } else if (data?.toolCall) {
            this.data = data.toolCall.functionCalls;
            this.type = "FUNCTION_CALL";
        }
    }
}

class GeminiLiveAPI {
    constructor(proxyUrl, projectId, model, apiHost) {
        this.proxyUrl = proxyUrl;

        this.projectId = projectId;
        this.model = model;
        this.modelUri = `projects/${this.projectId}/locations/us-central1/publishers/google/models/${this.model}`;

        this.responseModalities = ["AUDIO"];
        this.systemInstructions = "";
        this.tools = [];

        this.apiHost = apiHost;
        this.serviceUrl = `wss://${this.apiHost}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent`;

        this.onReceiveResponse = (message) => {
            console.log("Default message received callback", message);
        };

        this.onConnectionStarted = () => {
            console.log("Default onConnectionStarted");
        };

        this.onErrorMessage = (message) => {
            alert(message);
        };
        
        this.onFunctionCall = async (functionCalls) => {
            console.log("Default function call handler", functionCalls);
            return null;
        };

        this.accessToken = "";
        this.websocket = null;

        console.log("Created Gemini Live API object: ", this);
    }

    setProjectId(projectId) {
        this.projectId = projectId;
        this.modelUri = `projects/${this.projectId}/locations/us-central1/publishers/google/models/${this.model}`;
    }

    setAccessToken(newAccessToken) {
        console.log("setting access token: ", newAccessToken);
        this.accessToken = newAccessToken;
    }
    
    setTools(tools) {
        this.tools = tools;
    }

    connect(accessToken) {
        this.setAccessToken(accessToken);
        this.setupWebSocketToService();
    }

    disconnect() {
        this.webSocket.close();
    }

    sendMessage(message) {
        this.webSocket.send(JSON.stringify(message));
    }

    async onReceiveMessage(messageEvent) {
        console.log("Message received: ", messageEvent);
        const messageData = JSON.parse(messageEvent.data);
        const message = new GeminiLiveResponseMessage(messageData);
        
        if (message.type === "FUNCTION_CALL") {
            const functionCalls = message.data;
            console.log("Function call received:", functionCalls);
            
            try {
                const functionResults = await this.onFunctionCall(functionCalls);
                if (functionResults) {
                    this.sendToolResponse(functionCalls, functionResults);
                }
            } catch (error) {
                console.error("Error handling function call:", error);
            }
        }
        
        console.log("onReceiveMessageCallBack this ", this);
        this.onReceiveResponse(message);
    }

    setupWebSocketToService() {
        console.log("connecting: ", this.proxyUrl);

        this.webSocket = new WebSocket(this.proxyUrl);

        this.webSocket.onclose = (event) => {
            console.log("websocket closed: ", event);
            this.onErrorMessage("Connection closed");
        };

        this.webSocket.onerror = (event) => {
            console.log("websocket error: ", event);
            this.onErrorMessage("Connection error");
        };

        this.webSocket.onopen = (event) => {
            console.log("websocket open: ", event);
            this.sendInitialSetupMessages();
            this.onConnectionStarted();
        };

        this.webSocket.onmessage = (event) => this.onReceiveMessage(event);
    }

    sendInitialSetupMessages() {
        const serviceSetupMessage = {
            bearer_token: this.accessToken,
            service_url: this.serviceUrl,
        };
        this.sendMessage(serviceSetupMessage);

        const sessionSetupMessage = {
            setup: {
                model: this.modelUri,
                generation_config: {
                    response_modalities: this.responseModalities,
                },
                system_instruction: {
                    parts: [{ text: this.systemInstructions }],
                },
                tools: this.tools.length > 0 ? this.tools : undefined,
            },
        };
        this.sendMessage(sessionSetupMessage);
    }

    sendTextMessage(text) {
        const textMessage = {
            client_content: {
                turns: [
                    {
                        role: "user",
                        parts: [{ text: text }],
                    },
                ],
                turn_complete: true,
            },
        };
        this.sendMessage(textMessage);
    }

    sendRealtimeInputMessage(data, mime_type) {
        const message = {
            realtime_input: {
                media_chunks: [
                    {
                        mime_type: mime_type,
                        data: data,
                    },
                ],
            },
        };
        this.sendMessage(message);
    }

    sendAudioMessage(base64PCM) {
        this.sendRealtimeInputMessage(base64PCM, "audio/pcm");
    }

    sendImageMessage(base64Image, mime_type = "image/jpeg") {
        this.sendRealtimeInputMessage(base64Image, mime_type);
    }
    
    sendToolResponse(functionCalls, results) {
        const functionResponses = functionCalls.map((call, index) => {
            return {
                name: call.name,
                response: {
                    result: results[index] || null,
                },
            };
        });

        const message = {
            tool_response: {
                function_responses: functionResponses,
            },
        };
        
        this.sendMessage(message);
    }
}

// Discord function tools for Gemini
const askDiscordTools = [
    {
        functionDeclarations: [
            {
                name: "ask_discord_question",
                description: "Sends a question to Discord and waits for a reply",
                parameters: {
                    type: "OBJECT",
                    properties: {
                        question: {
                            type: "STRING", 
                            description: "The question to ask on Discord",
                        },
                        timeout: {
                            type: "NUMBER",
                            description: "Maximum time to wait for a response in seconds"
                        }
                    },
                    required: ["question"]
                }
            }
        ]
    }
];

// Handler for Discord functions
async function handleDiscordFunctionCall(functionCalls) {
    const results = [];
    
    for (const call of functionCalls) {
        if (call.name === "ask_discord_question") {
            try {
                const response = await fetch("http://localhost:8081/askdiscord", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        message: call.args.question,
                        wait_for_reply: true,
                        timeout: call.args.timeout || 60
                    })
                });
                
                const data = await response.json();
                results.push(data);
            } catch (error) {
                console.error("Error asking Discord question:", error);
                results.push({ error: error.message });
            }
        }
        else {
            results.push({ error: "Unknown function" });
        }
    }
    
    return results;
}

console.log("loaded gemini-live-api.js");
