import Fastify from 'fastify';
import WebSocket from 'ws';
import fs from 'fs';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import { url } from 'inspector';
import twilio from "twilio"
//import { TrustProductsChannelEndpointAssignmentContextImpl } from 'twilio/lib/rest/trusthub/v1/trustProducts/trustProductsChannelEndpointAssignment';

// Load environment variables from .env file
dotenv.config();



// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
let SYSTEM_MESSAGE = process.env.SYSTEM_MESSAGE || "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.";
const VOICE = process.env.VOICE || "alloy";
const PORT = process.env.PORT || 3000; // Allow dynamic port assignment
const MODEL = process.env.MODEL || "gpt-4o-realtime-preview";
const WSS_URL = process.env.WSS_URL || 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';//'wss://ik-oai-eastus-2.openai.azure.com/openai/realtime?api-key=b3e819600fbe4981be34ef2aa79943e2&deployment=gpt-4o-realtime-preview&api-version=2024-10-01-preview';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

 
// List of Event Types to log to the console. See OpenAI Realtime API Documentation. (session.updated is handled separately.)
const LOG_EVENT_TYPES = [
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Twilio Media Stream Server is running!' });
});

// Route for Twilio to handle incoming and outgoing calls
// <Say> punctuation to improve text-to-speech translation
fastify.all('/incoming-call', async (request, reply) => {
 
    SYSTEM_MESSAGE = process.env.SYSTEM_MESSAGE || "You are a helpful and bubbly AI assistant who loves to chat about anything the user is interested about and is prepared to offer them facts. You have a penchant for dad jokes, owl jokes, and rickrolling – subtly. Always stay positive, but work in a joke when appropriate.";
    
    const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response> 
                              <Connect>
                                  <Stream url="wss://${request.headers.host}/media-stream" />
                              </Connect>
                          </Response>`;

    reply.type('text/xml').send(twimlResponse);
});

fastify.all('/call', async (req, rep) => {
    
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const client = twilio(accountSid, authToken);

    if(req.query.phone) {
        if(req.query.system_message) {
            SYSTEM_MESSAGE = req.query.system_message
        }
        const call = await client.calls.create({
            from: "+85230011224",
            to: `+852${req.query.phone}`,
            twiml: `<Response>
                        <Connect>
                            <Stream url="wss://${req.headers.host}/media-stream" />
                        </Connect>
                    </Response>`,
        });
        console.log(`Calling: ${req.query.phone} : ${call.sid}`)
    }
    else {
        console.log(`no call`);
    }

    
}
);

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        const url = WSS_URL;
        const openAiWs = new WebSocket(url, {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        let streamSid = null;

        const sendSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendSessionUpdate, 250); // Ensure connection stability, send after .25 seconds
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openAiWs.on('message', async (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
                if (response.type === "input_audio_buffer.speech_started") {
                    console.log("interrupt");
                    const clear_twilio = {
                        "streamSid": streamSid,
                        "event": "clear"
                    }
                    await connection.send(JSON.stringify(clear_twilio))

                    const interrupt_message = {
                        "type": "response.cancel"
                    }
                    await openAiWs.send(JSON.stringify(interrupt_message))
                }


            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }

                        break;
                    case 'start':
                        streamSid = data.start.streamSid;

                        console.log('Incoming stream has started', streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${PORT}`);
});
