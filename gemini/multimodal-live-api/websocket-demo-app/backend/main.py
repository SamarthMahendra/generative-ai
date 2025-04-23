import asyncio
import json
from aiohttp import web
from aiohttp_cors import setup as cors_setup, ResourceOptions, CorsViewMixin
import websockets
from websockets.legacy.protocol import WebSocketCommonProtocol
from websockets.legacy.server import WebSocketServerProtocol
from discord_integration import send_message_to_channel, ask_and_get_reply

HOST = "us-central1-aiplatform.googleapis.com"
SERVICE_URL = f"wss://{HOST}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"

DEBUG = False


async def proxy_task(
    client_websocket: WebSocketCommonProtocol, server_websocket: WebSocketCommonProtocol
) -> None:
    """
    Forwards messages from one WebSocket connection to another.

    Args:
        client_websocket: The WebSocket connection from which to receive messages.
        server_websocket: The WebSocket connection to which to send messages.
    """
    async for message in client_websocket:
        try:
            data = json.loads(message)
            if DEBUG:
                print("proxying: ", data)
            await server_websocket.send(json.dumps(data))
        except Exception as e:
            print(f"Error processing message: {e}")

    await server_websocket.close()


async def create_proxy(
    client_websocket: WebSocketCommonProtocol, bearer_token: str
) -> None:
    """
    Establishes a WebSocket connection to the server and creates two tasks for
    bidirectional message forwarding between the client and the server.

    Args:
        client_websocket: The WebSocket connection of the client.
        bearer_token: The bearer token for authentication with the server.
    """

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {bearer_token}",
    }

    async with websockets.connect(
        SERVICE_URL, additional_headers=headers
    ) as server_websocket:
        client_to_server_task = asyncio.create_task(
            proxy_task(client_websocket, server_websocket)
        )
        server_to_client_task = asyncio.create_task(
            proxy_task(server_websocket, client_websocket)
        )
        await asyncio.gather(client_to_server_task, server_to_client_task)


async def handle_client(client_websocket: WebSocketServerProtocol) -> None:
    """
    Handles a new client connection, expecting the first message to contain a bearer token.
    Establishes a proxy connection to the server upon successful authentication.

    Args:
        client_websocket: The WebSocket connection of the client.
    """
    print("New connection...")
    # Wait for the first message from the client
    auth_message = await asyncio.wait_for(client_websocket.recv(), timeout=5.0)
    auth_data = json.loads(auth_message)

    if "bearer_token" in auth_data:
        bearer_token = auth_data["bearer_token"]
    else:
        print("Error: Bearer token not found in the first message.")
        await client_websocket.close(code=1008, reason="Bearer token missing")
        return

    await create_proxy(client_websocket, bearer_token)


async def handle_askdiscord(request):
    """
    HTTP endpoint to handle Discord function calls from Gemini.
    
    Expected JSON body:
    {
        "message": "Message to send to Discord",
        "wait_for_reply": true/false,
        "timeout": 60
    }
    """
    try:
        data = await request.json()
        message = data.get("message")
        wait_for_reply = data.get("wait_for_reply", False)
        timeout = data.get("timeout", 60)
        
        if not message:
            return web.json_response({"error": "Message is required"}, status=400)
        
        if wait_for_reply:
            reply = await ask_and_get_reply(message, timeout=timeout)
            return web.json_response({"reply": reply})
        else:
            # Fire and forget
            asyncio.create_task(send_message_to_channel(message))
            return web.json_response({"status": "Message sent"})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

async def start_websocket_server():
    """
    Starts the WebSocket server and listens for incoming client connections.
    """
    async with websockets.serve(handle_client, "localhost", 8080):
        print("Running websocket server localhost:8080...")
        # Run forever
        await asyncio.Future()

async def main() -> None:
    """
    Starts both the WebSocket server and the HTTP API server.
    """
    # Setup HTTP routes
    app = web.Application()
    app.router.add_post('/askdiscord', handle_askdiscord)
    
    # Configure CORS
    cors = cors_setup(app, defaults={
        "*": ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
            allow_methods=["POST"]
        )
    })
    
    # Apply CORS to all routes
    for route in list(app.router.routes()):
        cors.add(route)
    
    # Start HTTP server
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, 'localhost', 8081)
    await site.start()
    print("Running HTTP API server localhost:8081...")
    
    # Start WebSocket server
    await start_websocket_server()


if __name__ == "__main__":
    asyncio.run(main())
