import TcpSocket from 'react-native-tcp-socket';
import {modelStore} from '../store/ModelStore';

let server: any = null;
let busy = false;

function sendJson(socket: any, status: number, body: unknown) {
  const statusText: Record<number, string> = {
    200: 'OK',
    204: 'No Content',
    400: 'Bad Request',
    404: 'Not Found',
    409: 'Conflict',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
  };

  const payload = JSON.stringify(body);

  socket.end(
    `HTTP/1.1 ${status} ${statusText[status] || 'OK'}\r\n` +
      'Content-Type: application/json; charset=utf-8\r\n' +
      'Access-Control-Allow-Origin: *\r\n' +
      'Access-Control-Allow-Headers: Content-Type, Authorization\r\n' +
      'Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n' +
      'Connection: close\r\n' +
      '\r\n' +
      payload,
  );
}

function utf8Length(text: string) {
  return encodeURIComponent(text).replace(/%[0-9A-F]{2}/gi, 'x').length;
}

async function handleRequest(socket: any, raw: string) {
  const headerEnd = raw.indexOf('\r\n\r\n');

  if (headerEnd === -1) {
    return false;
  }

  const headerText = raw.slice(0, headerEnd);
  const bodyText = raw.slice(headerEnd + 4);

  const lines = headerText.split('\r\n');
  const [method, rawPath] = lines[0].split(' ');
  const path = rawPath?.split('?')[0];

  const contentLengthLine = lines.find(line =>
    line.toLowerCase().startsWith('content-length:'),
  );

  const contentLength = contentLengthLine
    ? Number(contentLengthLine.split(':')[1].trim())
    : 0;

  if (contentLength > 0 && utf8Length(bodyText) < contentLength) {
    return false;
  }

  if (method === 'OPTIONS') {
    sendJson(socket, 204, {});
    return true;
  }

  if (method === 'GET' && path === '/v1/models') {
    sendJson(socket, 200, {
      object: 'list',
      data: [
        {
          id: 'local',
          object: 'model',
          created: 0,
          owned_by: 'pocketpal',
        },
      ],
    });

    return true;
  }

  if (method === 'POST' && path === '/v1/chat/completions') {
    if (!modelStore.context || !modelStore.engine) {
      sendJson(socket, 503, {
        error: 'No local model loaded in PocketPal',
      });
      return true;
    }

    if (busy || modelStore.inferencing || modelStore.isStreaming) {
      sendJson(socket, 409, {
        error: 'Model is busy',
      });
      return true;
    }

    try {
      const body = JSON.parse(bodyText);

      if (!Array.isArray(body.messages)) {
        sendJson(socket, 400, {
          error: 'messages must be an array',
        });
        return true;
      }

      if (body.stream === true) {
        sendJson(socket, 400, {
          error: 'Streaming is not supported yet. Use stream:false.',
        });
        return true;
      }

      busy = true;

      const result = await modelStore.engine.completion({
        messages: body.messages,
        n_predict:
          typeof body.max_tokens === 'number' ? body.max_tokens : 150,
        temperature:
          typeof body.temperature === 'number' ? body.temperature : 0.7,
        top_p: typeof body.top_p === 'number' ? body.top_p : 0.9,
        stop: body.stop,
      });

      sendJson(socket, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'local',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: result.content || result.text || '',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: result.tokens_evaluated ?? 0,
          completion_tokens: result.tokens_predicted ?? 0,
          total_tokens:
            (result.tokens_evaluated ?? 0) +
            (result.tokens_predicted ?? 0),
        },
      });
    } catch (error) {
      sendJson(socket, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      busy = false;
    }

    return true;
  }

  sendJson(socket, 404, {
    error: 'Not found',
  });

  return true;
}

export function startLocalApiServer(port = 8080) {
  if (server?.listening) {
    console.log('[LocalAPI] Server already running');
    return;
  }

  server = TcpSocket.createServer((socket: any) => {
    let request = '';
    let handled = false;

    socket.on('data', async (data: any) => {
      if (handled) {
        return;
      }

      request += data.toString();

      try {
        handled = await handleRequest(socket, request);
      } catch (error) {
        handled = true;

        sendJson(socket, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on('error', (error: unknown) => {
      console.log('[LocalAPI] Client error:', error);
    });
  });

  server.on('error', (error: unknown) => {
    console.log('[LocalAPI] Server error:', error);
  });

  server.listen(
    {
      port,
      host: '0.0.0.0',
    },
    () => {
      console.log(`[LocalAPI] Listening on port ${port}`);
    },
  );
}

export function stopLocalApiServer() {
  if (!server) {
    return;
  }

  server.close();
  server = null;

  console.log('[LocalAPI] Server stopped');
}