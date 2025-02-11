// src/index.ts
import bodyParser3 from "body-parser";
import cors3 from "cors";
import express3 from "express";
import multer from "multer";
import { z } from "zod";
import {
  elizaLogger as elizaLogger3,
  messageCompletionFooter,
  generateCaption,
  generateImage,
  getEmbeddingZeroVector,
  composeContext,
  generateMessageResponse,
  generateObject,
  ModelClass,
  stringToUuid,
  settings
} from "@elizaos/core";

// src/api.ts
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import path from "path";
import fs from "fs";
import {
  elizaLogger,
  getEnvVariable,
  validateCharacterConfig,
  ServiceType
} from "@elizaos/core";
import { REST, Routes } from "discord.js";
import { validateUuid } from "@elizaos/core";
function validateUUIDParams(params, res) {
  const agentId = validateUuid(params.agentId);
  if (!agentId) {
    res.status(400).json({
      error: "Invalid AgentId format. Expected to be a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
    });
    return null;
  }
  if (params.roomId) {
    const roomId = validateUuid(params.roomId);
    if (!roomId) {
      res.status(400).json({
        error: "Invalid RoomId format. Expected to be a UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
      });
      return null;
    }
    return { agentId, roomId };
  }
  return { agentId };
}
function createApiRouter(agents, directClient) {
  const router = express.Router();
  router.use(cors());
  router.use(bodyParser.json());
  router.use(bodyParser.urlencoded({ extended: true }));
  router.use(
    express.json({
      limit: getEnvVariable("EXPRESS_MAX_PAYLOAD") || "100kb"
    })
  );
  router.get("/", (req, res) => {
    res.send("Welcome, this is the REST API!");
  });
  router.get("/hello", (req, res) => {
    res.json({ message: "Hello World!" });
  });
  router.get("/agents", (req, res) => {
    const agentsList = Array.from(agents.values()).map((agent) => ({
      id: agent.agentId,
      name: agent.character.name,
      clients: Object.keys(agent.clients)
    }));
    res.json({ agents: agentsList });
  });
  router.get("/storage", async (req, res) => {
    try {
      const uploadDir = path.join(process.cwd(), "data", "characters");
      const files = await fs.promises.readdir(uploadDir);
      res.json({ files });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  router.get("/agents/:agentId", (req, res) => {
    const { agentId } = validateUUIDParams(req.params, res) ?? {
      agentId: null
    };
    if (!agentId) return;
    const agent = agents.get(agentId);
    if (!agent) {
      res.status(404).json({ error: "Agent not found" });
      return;
    }
    const character = agent?.character;
    if (character?.settings?.secrets) {
      delete character.settings.secrets;
    }
    res.json({
      id: agent.agentId,
      character: agent.character
    });
  });
  router.delete("/agents/:agentId", async (req, res) => {
    const { agentId } = validateUUIDParams(req.params, res) ?? {
      agentId: null
    };
    if (!agentId) return;
    const agent = agents.get(agentId);
    if (agent) {
      agent.stop();
      directClient.unregisterAgent(agent);
      res.status(204).json({ success: true });
    } else {
      res.status(404).json({ error: "Agent not found" });
    }
  });
  router.post("/agents/:agentId/set", async (req, res) => {
    const { agentId } = validateUUIDParams(req.params, res) ?? {
      agentId: null
    };
    if (!agentId) return;
    let agent = agents.get(agentId);
    if (agent) {
      agent.stop();
      directClient.unregisterAgent(agent);
    }
    const characterJson = { ...req.body };
    const character = req.body;
    try {
      validateCharacterConfig(character);
    } catch (e) {
      elizaLogger.error(`Error parsing character: ${e}`);
      res.status(400).json({
        success: false,
        message: e.message
      });
      return;
    }
    try {
      agent = await directClient.startAgent(character);
      elizaLogger.log(`${character.name} started`);
    } catch (e) {
      elizaLogger.error(`Error starting agent: ${e}`);
      res.status(500).json({
        success: false,
        message: e.message
      });
      return;
    }
    if (process.env.USE_CHARACTER_STORAGE === "true") {
      try {
        const filename = `${agent.agentId}.json`;
        const uploadDir = path.join(
          process.cwd(),
          "data",
          "characters"
        );
        const filepath = path.join(uploadDir, filename);
        await fs.promises.mkdir(uploadDir, { recursive: true });
        await fs.promises.writeFile(
          filepath,
          JSON.stringify(
            { ...characterJson, id: agent.agentId },
            null,
            2
          )
        );
        elizaLogger.info(
          `Character stored successfully at ${filepath}`
        );
      } catch (error) {
        elizaLogger.error(
          `Failed to store character: ${error.message}`
        );
      }
    }
    res.json({
      id: character.id,
      character
    });
  });
  router.get("/agents/:agentId/channels", async (req, res) => {
    const { agentId } = validateUUIDParams(req.params, res) ?? {
      agentId: null
    };
    if (!agentId) return;
    const runtime = agents.get(agentId);
    if (!runtime) {
      res.status(404).json({ error: "Runtime not found" });
      return;
    }
    const API_TOKEN = runtime.getSetting("DISCORD_API_TOKEN");
    const rest = new REST({ version: "10" }).setToken(API_TOKEN);
    try {
      const guilds = await rest.get(Routes.userGuilds());
      res.json({
        id: runtime.agentId,
        guilds,
        serverCount: guilds.length
      });
    } catch (error) {
      console.error("Error fetching guilds:", error);
      res.status(500).json({ error: "Failed to fetch guilds" });
    }
  });
  router.get("/agents/:agentId/:roomId/memories", async (req, res) => {
    const { agentId, roomId } = validateUUIDParams(req.params, res) ?? {
      agentId: null,
      roomId: null
    };
    if (!agentId || !roomId) return;
    let runtime = agents.get(agentId);
    if (!runtime) {
      runtime = Array.from(agents.values()).find(
        (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
      );
    }
    if (!runtime) {
      res.status(404).send("Agent not found");
      return;
    }
    try {
      const memories = await runtime.messageManager.getMemories({
        roomId
      });
      const response = {
        agentId,
        roomId,
        memories: memories.map((memory) => ({
          id: memory.id,
          userId: memory.userId,
          agentId: memory.agentId,
          createdAt: memory.createdAt,
          content: {
            text: memory.content.text,
            action: memory.content.action,
            source: memory.content.source,
            url: memory.content.url,
            inReplyTo: memory.content.inReplyTo,
            attachments: memory.content.attachments?.map(
              (attachment) => ({
                id: attachment.id,
                url: attachment.url,
                title: attachment.title,
                source: attachment.source,
                description: attachment.description,
                text: attachment.text,
                contentType: attachment.contentType
              })
            )
          },
          embedding: memory.embedding,
          roomId: memory.roomId,
          unique: memory.unique,
          similarity: memory.similarity
        }))
      };
      res.json(response);
    } catch (error) {
      console.error("Error fetching memories:", error);
      res.status(500).json({ error: "Failed to fetch memories" });
    }
  });
  router.get("/tee/agents", async (req, res) => {
    try {
      const allAgents = [];
      for (const agentRuntime of agents.values()) {
        const teeLogService2 = agentRuntime.getService(ServiceType.TEE_LOG).getInstance();
        const agents2 = await teeLogService2.getAllAgents();
        allAgents.push(...agents2);
      }
      const runtime = agents.values().next().value;
      const teeLogService = runtime.getService(ServiceType.TEE_LOG).getInstance();
      const attestation = await teeLogService.generateAttestation(
        JSON.stringify(allAgents)
      );
      res.json({ agents: allAgents, attestation });
    } catch (error) {
      elizaLogger.error("Failed to get TEE agents:", error);
      res.status(500).json({
        error: "Failed to get TEE agents"
      });
    }
  });
  router.get("/tee/agents/:agentId", async (req, res) => {
    try {
      const agentId = req.params.agentId;
      const agentRuntime = agents.get(agentId);
      if (!agentRuntime) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }
      const teeLogService = agentRuntime.getService(ServiceType.TEE_LOG).getInstance();
      const teeAgent = await teeLogService.getAgent(agentId);
      const attestation = await teeLogService.generateAttestation(
        JSON.stringify(teeAgent)
      );
      res.json({ agent: teeAgent, attestation });
    } catch (error) {
      elizaLogger.error("Failed to get TEE agent:", error);
      res.status(500).json({
        error: "Failed to get TEE agent"
      });
    }
  });
  router.post(
    "/tee/logs",
    async (req, res) => {
      try {
        const query = req.body.query || {};
        const page = Number.parseInt(req.body.page) || 1;
        const pageSize = Number.parseInt(req.body.pageSize) || 10;
        const teeLogQuery = {
          agentId: query.agentId || "",
          roomId: query.roomId || "",
          userId: query.userId || "",
          type: query.type || "",
          containsContent: query.containsContent || "",
          startTimestamp: query.startTimestamp || void 0,
          endTimestamp: query.endTimestamp || void 0
        };
        const agentRuntime = agents.values().next().value;
        const teeLogService = agentRuntime.getService(ServiceType.TEE_LOG).getInstance();
        const pageQuery = await teeLogService.getLogs(
          teeLogQuery,
          page,
          pageSize
        );
        const attestation = await teeLogService.generateAttestation(
          JSON.stringify(pageQuery)
        );
        res.json({
          logs: pageQuery,
          attestation
        });
      } catch (error) {
        elizaLogger.error("Failed to get TEE logs:", error);
        res.status(500).json({
          error: "Failed to get TEE logs"
        });
      }
    }
  );
  router.post("/agent/start", async (req, res) => {
    const { characterPath, characterJson } = req.body;
    console.log("characterPath:", characterPath);
    console.log("characterJson:", characterJson);
    try {
      let character;
      if (characterJson) {
        character = await directClient.jsonToCharacter(
          characterPath,
          characterJson
        );
      } else if (characterPath) {
        character = await directClient.loadCharacterTryPath(characterPath);
      } else {
        throw new Error("No character path or JSON provided");
      }
      await directClient.startAgent(character);
      elizaLogger.log(`${character.name} started`);
      res.json({
        id: character.id,
        character
      });
    } catch (e) {
      elizaLogger.error(`Error parsing character: ${e}`);
      res.status(400).json({
        error: e.message
      });
      return;
    }
  });
  router.post("/agents/:agentId/stop", async (req, res) => {
    const agentId = req.params.agentId;
    console.log("agentId", agentId);
    const agent = agents.get(agentId);
    if (agent) {
      agent.stop();
      directClient.unregisterAgent(agent);
      res.json({ success: true });
    } else {
      res.status(404).json({ error: "Agent not found" });
    }
  });
  return router;
}

// src/index.ts
import * as fs2 from "fs";
import * as path2 from "path";

// src/verifiable-log-api.ts
import express2 from "express";
import bodyParser2 from "body-parser";
import cors2 from "cors";
import { elizaLogger as elizaLogger2, ServiceType as ServiceType2 } from "@elizaos/core";
function createVerifiableLogApiRouter(agents) {
  const router = express2.Router();
  router.use(cors2());
  router.use(bodyParser2.json());
  router.use(bodyParser2.urlencoded({ extended: true }));
  router.get(
    "/verifiable/agents",
    async (req, res) => {
      try {
        const agentRuntime = agents.values().next().value;
        const pageQuery = await agentRuntime.getService(
          ServiceType2.VERIFIABLE_LOGGING
        ).listAgent();
        res.json({
          success: true,
          message: "Successfully get Agents",
          data: pageQuery
        });
      } catch (error) {
        elizaLogger2.error("Detailed error:", error);
        res.status(500).json({
          error: "failed to get agents registered ",
          details: error.message,
          stack: error.stack
        });
      }
    }
  );
  router.post(
    "/verifiable/attestation",
    async (req, res) => {
      try {
        const query = req.body || {};
        const verifiableLogQuery = {
          agentId: query.agentId || "",
          publicKey: query.publicKey || ""
        };
        const agentRuntime = agents.values().next().value;
        const pageQuery = await agentRuntime.getService(
          ServiceType2.VERIFIABLE_LOGGING
        ).generateAttestation(verifiableLogQuery);
        res.json({
          success: true,
          message: "Successfully get Attestation",
          data: pageQuery
        });
      } catch (error) {
        elizaLogger2.error("Detailed error:", error);
        res.status(500).json({
          error: "Failed to Get Attestation",
          details: error.message,
          stack: error.stack
        });
      }
    }
  );
  router.post(
    "/verifiable/logs",
    async (req, res) => {
      try {
        const query = req.body.query || {};
        const page = Number.parseInt(req.body.page) || 1;
        const pageSize = Number.parseInt(req.body.pageSize) || 10;
        const verifiableLogQuery = {
          idEq: query.idEq || "",
          agentIdEq: query.agentIdEq || "",
          roomIdEq: query.roomIdEq || "",
          userIdEq: query.userIdEq || "",
          typeEq: query.typeEq || "",
          contLike: query.contLike || "",
          signatureEq: query.signatureEq || ""
        };
        const agentRuntime = agents.values().next().value;
        const pageQuery = await agentRuntime.getService(
          ServiceType2.VERIFIABLE_LOGGING
        ).pageQueryLogs(verifiableLogQuery, page, pageSize);
        res.json({
          success: true,
          message: "Successfully retrieved logs",
          data: pageQuery
        });
      } catch (error) {
        elizaLogger2.error("Detailed error:", error);
        res.status(500).json({
          error: "Failed to Get Verifiable Logs",
          details: error.message,
          stack: error.stack
        });
      }
    }
  );
  return router;
}

// src/index.ts
import OpenAI from "openai";
var storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path2.join(process.cwd(), "data", "uploads");
    if (!fs2.existsSync(uploadDir)) {
      fs2.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  }
});
var upload = multer({
  storage
  /*: multer.memoryStorage() */
});
var messageHandlerTemplate = (
  // {{goals}}
  // "# Action Examples" is already included
  `{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.
` + messageCompletionFooter
);
var hyperfiHandlerTemplate = `{{actionExamples}}
(Action examples are for reference only. Do not use the information from them in your response.)

# Knowledge
{{knowledge}}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

{{providers}}

{{attachments}}

# Capabilities
Note that {{agentName}} is capable of reading/seeing/hearing various forms of media, including images, videos, audio, plaintext and PDFs. Recent attachments have been included above under the "Attachments" section.

{{messageDirections}}

{{recentMessages}}

{{actions}}

# Instructions: Write the next message for {{agentName}}.

Response format should be formatted in a JSON block like this:
\`\`\`json
{ "lookAt": "{{nearby}}" or null, "emote": "{{emotes}}" or null, "say": "string" or null, "actions": (array of strings) or null }
\`\`\`
`;
var DirectClient = class {
  app;
  agents;
  // container management
  server;
  // Store server instance
  startAgent;
  // Store startAgent functor
  loadCharacterTryPath;
  // Store loadCharacterTryPath functor
  jsonToCharacter;
  // Store jsonToCharacter functor
  constructor() {
    elizaLogger3.log("DirectClient constructor");
    this.app = express3();
    this.app.use(cors3());
    this.agents = /* @__PURE__ */ new Map();
    this.app.use(bodyParser3.json());
    this.app.use(bodyParser3.urlencoded({ extended: true }));
    this.app.use(
      "/media/uploads",
      express3.static(path2.join(process.cwd(), "/data/uploads"))
    );
    this.app.use(
      "/media/generated",
      express3.static(path2.join(process.cwd(), "/generatedImages"))
    );
    const apiRouter = createApiRouter(this.agents, this);
    this.app.use(apiRouter);
    const apiLogRouter = createVerifiableLogApiRouter(this.agents);
    this.app.use(apiLogRouter);
    this.app.post(
      "/:agentId/whisper",
      upload.single("file"),
      async (req, res) => {
        const audioFile = req.file;
        const agentId = req.params.agentId;
        if (!audioFile) {
          res.status(400).send("No audio file provided");
          return;
        }
        let runtime = this.agents.get(agentId);
        const apiKey = runtime.getSetting("OPENAI_API_KEY");
        if (!runtime) {
          runtime = Array.from(this.agents.values()).find(
            (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
          );
        }
        if (!runtime) {
          res.status(404).send("Agent not found");
          return;
        }
        const openai = new OpenAI({
          apiKey
        });
        const transcription = await openai.audio.transcriptions.create({
          file: fs2.createReadStream(audioFile.path),
          model: "whisper-1"
        });
        res.json(transcription);
      }
    );
    this.app.post(
      "/:agentId/message",
      upload.single("file"),
      async (req, res) => {
        const agentId = req.params.agentId;
        const roomId = stringToUuid(
          req.body.roomId ?? "default-room-" + agentId
        );
        const userId = stringToUuid(req.body.userId ?? "user");
        let runtime = this.agents.get(agentId);
        if (!runtime) {
          runtime = Array.from(this.agents.values()).find(
            (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
          );
        }
        if (!runtime) {
          res.status(404).send("Agent not found");
          return;
        }
        await runtime.ensureConnection(
          userId,
          roomId,
          req.body.userName,
          req.body.name,
          "direct"
        );
        const text = req.body.text;
        if (!text) {
          res.json([]);
          return;
        }
        const messageId = stringToUuid(Date.now().toString());
        const attachments = [];
        if (req.file) {
          const filePath = path2.join(
            process.cwd(),
            "data",
            "uploads",
            req.file.filename
          );
          attachments.push({
            id: Date.now().toString(),
            url: filePath,
            title: req.file.originalname,
            source: "direct",
            description: `Uploaded file: ${req.file.originalname}`,
            text: "",
            contentType: req.file.mimetype
          });
        }
        const content = {
          text,
          attachments,
          source: "direct",
          inReplyTo: void 0
        };
        const userMessage = {
          content,
          userId,
          roomId,
          agentId: runtime.agentId
        };
        const memory = {
          id: stringToUuid(messageId + "-" + userId),
          ...userMessage,
          agentId: runtime.agentId,
          userId,
          roomId,
          content,
          createdAt: Date.now()
        };
        await runtime.messageManager.addEmbeddingToMemory(memory);
        await runtime.messageManager.createMemory(memory);
        let state = await runtime.composeState(userMessage, {
          agentName: runtime.character.name
        });
        const context = composeContext({
          state,
          template: messageHandlerTemplate
        });
        const response = await generateMessageResponse({
          runtime,
          context,
          modelClass: ModelClass.LARGE
        });
        if (!response) {
          res.status(500).send(
            "No response from generateMessageResponse"
          );
          return;
        }
        const responseMessage = {
          id: stringToUuid(messageId + "-" + runtime.agentId),
          ...userMessage,
          userId: runtime.agentId,
          content: response,
          embedding: getEmbeddingZeroVector(),
          createdAt: Date.now()
        };
        let message = null;
        let status = void 0;
        await runtime.processActions(
          memory,
          [responseMessage],
          state,
          async (newMessages, undefined2, _status) => {
            message = newMessages;
            status = _status;
            return [memory];
          }
        );
        if (status?.saveAIResponseMessage) {
          await runtime.messageManager.createMemory(responseMessage);
        }
        if (message && status?.saveCallbackMessage) {
          responseMessage.content = message;
          await runtime.messageManager.createMemory(responseMessage);
        }
        state = await runtime.updateRecentMessageState(state);
        await runtime.evaluate(memory, state);
        const action = runtime.actions.find(
          (a) => a.name === response.action
        );
        const shouldSuppressInitialMessage = action?.suppressInitialMessage;
        if (!shouldSuppressInitialMessage) {
          if (message) {
            res.json([response, message]);
          } else {
            res.json([response]);
          }
        } else {
          if (message) {
            res.json([message]);
          } else {
            res.json([]);
          }
        }
      }
    );
    this.app.post(
      "/agents/:agentIdOrName/hyperfi/v1",
      async (req, res) => {
        const agentId = req.params.agentIdOrName;
        let runtime = this.agents.get(agentId);
        if (!runtime) {
          runtime = Array.from(this.agents.values()).find(
            (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
          );
        }
        if (!runtime) {
          res.status(404).send("Agent not found");
          return;
        }
        const roomId = stringToUuid(req.body.roomId ?? "hyperfi");
        const body = req.body;
        let nearby = [];
        let availableEmotes = [];
        if (body.nearby) {
          nearby = body.nearby;
        }
        if (body.messages) {
          for (const msg of body.messages) {
            const parts = msg.split(/:\s*/);
            const mUserId = stringToUuid(parts[0]);
            await runtime.ensureConnection(
              mUserId,
              roomId,
              // where
              parts[0],
              // username
              parts[0],
              // userScreeName?
              "hyperfi"
            );
            const content2 = {
              text: parts[1] || "",
              attachments: [],
              source: "hyperfi",
              inReplyTo: void 0
            };
            const memory = {
              id: stringToUuid(msg),
              agentId: runtime.agentId,
              userId: mUserId,
              roomId,
              content: content2
            };
            await runtime.messageManager.createMemory(memory);
          }
        }
        if (body.availableEmotes) {
          availableEmotes = body.availableEmotes;
        }
        const content = {
          // we need to compose who's near and what emotes are available
          text: JSON.stringify(req.body),
          attachments: [],
          source: "hyperfi",
          inReplyTo: void 0
        };
        const userId = stringToUuid("hyperfi");
        const userMessage = {
          content,
          userId,
          roomId,
          agentId: runtime.agentId
        };
        const state = await runtime.composeState(userMessage, {
          agentName: runtime.character.name
        });
        let template = hyperfiHandlerTemplate;
        template = template.replace(
          "{{emotes}}",
          availableEmotes.join("|")
        );
        template = template.replace("{{nearby}}", nearby.join("|"));
        const context = composeContext({
          state,
          template
        });
        function createHyperfiOutSchema(nearby2, availableEmotes2) {
          const lookAtSchema = nearby2.length > 1 ? z.union(
            nearby2.map((item) => z.literal(item))
          ).nullable() : nearby2.length === 1 ? z.literal(nearby2[0]).nullable() : z.null();
          const emoteSchema = availableEmotes2.length > 1 ? z.union(
            availableEmotes2.map(
              (item) => z.literal(item)
            )
          ).nullable() : availableEmotes2.length === 1 ? z.literal(availableEmotes2[0]).nullable() : z.null();
          return z.object({
            lookAt: lookAtSchema,
            emote: emoteSchema,
            say: z.string().nullable(),
            actions: z.array(z.string()).nullable()
          });
        }
        const hyperfiOutSchema = createHyperfiOutSchema(
          nearby,
          availableEmotes
        );
        const response = await generateObject({
          runtime,
          context,
          modelClass: ModelClass.SMALL,
          // 1s processing time on openai small
          schema: hyperfiOutSchema
        });
        if (!response) {
          res.status(500).send(
            "No response from generateMessageResponse"
          );
          return;
        }
        let hfOut;
        try {
          hfOut = hyperfiOutSchema.parse(response.object);
        } catch {
          elizaLogger3.error(
            "cant serialize response",
            response.object
          );
          res.status(500).send("Error in LLM response, try again");
          return;
        }
        new Promise((resolve) => {
          const contentObj = {
            text: hfOut.say
          };
          if (hfOut.lookAt !== null || hfOut.emote !== null) {
            contentObj.text += ". Then I ";
            if (hfOut.lookAt !== null) {
              contentObj.text += "looked at " + hfOut.lookAt;
              if (hfOut.emote !== null) {
                contentObj.text += " and ";
              }
            }
            if (hfOut.emote !== null) {
              contentObj.text = "emoted " + hfOut.emote;
            }
          }
          if (hfOut.actions !== null) {
            contentObj.action = hfOut.actions[0];
          }
          const responseMessage = {
            ...userMessage,
            userId: runtime.agentId,
            content: contentObj
          };
          runtime.messageManager.createMemory(responseMessage).then(() => {
            const messageId = stringToUuid(
              Date.now().toString()
            );
            const memory = {
              id: messageId,
              agentId: runtime.agentId,
              userId,
              roomId,
              content,
              createdAt: Date.now()
            };
            runtime.evaluate(memory, state).then(() => {
              if (contentObj.action) {
                runtime.processActions(
                  memory,
                  [responseMessage],
                  state,
                  async (_newMessages) => {
                    return [memory];
                  }
                );
              }
              resolve(true);
            });
          });
        });
        res.json({ response: hfOut });
      }
    );
    this.app.post(
      "/:agentId/image",
      async (req, res) => {
        const agentId = req.params.agentId;
        const agent = this.agents.get(agentId);
        if (!agent) {
          res.status(404).send("Agent not found");
          return;
        }
        const images = await generateImage({ ...req.body }, agent);
        const imagesRes = [];
        if (images.data && images.data.length > 0) {
          for (let i = 0; i < images.data.length; i++) {
            const caption = await generateCaption(
              { imageUrl: images.data[i] },
              agent
            );
            imagesRes.push({
              image: images.data[i],
              caption: caption.title
            });
          }
        }
        res.json({ images: imagesRes });
      }
    );
    this.app.post(
      "/fine-tune",
      async (req, res) => {
        try {
          const response = await fetch(
            "https://api.bageldb.ai/api/v1/asset",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-API-KEY": `${process.env.BAGEL_API_KEY}`
              },
              body: JSON.stringify(req.body)
            }
          );
          const data = await response.json();
          res.json(data);
        } catch (error) {
          res.status(500).json({
            error: "Please create an account at bakery.bagel.net and get an API key. Then set the BAGEL_API_KEY environment variable.",
            details: error.message
          });
        }
      }
    );
    this.app.get(
      "/fine-tune/:assetId",
      async (req, res) => {
        const assetId = req.params.assetId;
        const downloadDir = path2.join(
          process.cwd(),
          "downloads",
          assetId
        );
        elizaLogger3.log("Download directory:", downloadDir);
        try {
          elizaLogger3.log("Creating directory...");
          await fs2.promises.mkdir(downloadDir, { recursive: true });
          elizaLogger3.log("Fetching file...");
          const fileResponse = await fetch(
            `https://api.bageldb.ai/api/v1/asset/${assetId}/download`,
            {
              headers: {
                "X-API-KEY": `${process.env.BAGEL_API_KEY}`
              }
            }
          );
          if (!fileResponse.ok) {
            throw new Error(
              `API responded with status ${fileResponse.status}: ${await fileResponse.text()}`
            );
          }
          elizaLogger3.log("Response headers:", fileResponse.headers);
          const fileName = fileResponse.headers.get("content-disposition")?.split("filename=")[1]?.replace(
            /"/g,
            /* " */
            ""
          ) || "default_name.txt";
          elizaLogger3.log("Saving as:", fileName);
          const arrayBuffer = await fileResponse.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const filePath = path2.join(downloadDir, fileName);
          elizaLogger3.log("Full file path:", filePath);
          await fs2.promises.writeFile(filePath, buffer);
          const stats = await fs2.promises.stat(filePath);
          elizaLogger3.log(
            "File written successfully. Size:",
            stats.size,
            "bytes"
          );
          res.json({
            success: true,
            message: "Single file downloaded successfully",
            downloadPath: downloadDir,
            fileCount: 1,
            fileName,
            fileSize: stats.size
          });
        } catch (error) {
          elizaLogger3.error("Detailed error:", error);
          res.status(500).json({
            error: "Failed to download files from BagelDB",
            details: error.message,
            stack: error.stack
          });
        }
      }
    );
    this.app.post("/:agentId/speak", async (req, res) => {
      const agentId = req.params.agentId;
      const roomId = stringToUuid(
        req.body.roomId ?? "default-room-" + agentId
      );
      const userId = stringToUuid(req.body.userId ?? "user");
      const text = req.body.text;
      if (!text) {
        res.status(400).send("No text provided");
        return;
      }
      let runtime = this.agents.get(agentId);
      if (!runtime) {
        runtime = Array.from(this.agents.values()).find(
          (a) => a.character.name.toLowerCase() === agentId.toLowerCase()
        );
      }
      if (!runtime) {
        res.status(404).send("Agent not found");
        return;
      }
      try {
        await runtime.ensureConnection(
          userId,
          roomId,
          req.body.userName,
          req.body.name,
          "direct"
        );
        const messageId = stringToUuid(Date.now().toString());
        const content = {
          text,
          attachments: [],
          source: "direct",
          inReplyTo: void 0
        };
        const userMessage = {
          content,
          userId,
          roomId,
          agentId: runtime.agentId
        };
        const memory = {
          id: messageId,
          agentId: runtime.agentId,
          userId,
          roomId,
          content,
          createdAt: Date.now()
        };
        await runtime.messageManager.createMemory(memory);
        const state = await runtime.composeState(userMessage, {
          agentName: runtime.character.name
        });
        const context = composeContext({
          state,
          template: messageHandlerTemplate
        });
        const response = await generateMessageResponse({
          runtime,
          context,
          modelClass: ModelClass.LARGE
        });
        const responseMessage = {
          ...userMessage,
          userId: runtime.agentId,
          content: response
        };
        await runtime.messageManager.createMemory(responseMessage);
        if (!response) {
          res.status(500).send(
            "No response from generateMessageResponse"
          );
          return;
        }
        await runtime.evaluate(memory, state);
        const _result = await runtime.processActions(
          memory,
          [responseMessage],
          state,
          async () => {
            return [memory];
          }
        );
        const textToSpeak = response.text;
        const elevenLabsApiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
        const apiKey = process.env.ELEVENLABS_XI_API_KEY;
        if (!apiKey) {
          throw new Error("ELEVENLABS_XI_API_KEY not configured");
        }
        const speechResponse = await fetch(elevenLabsApiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey
          },
          body: JSON.stringify({
            text: textToSpeak,
            model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
            voice_settings: {
              stability: Number.parseFloat(
                process.env.ELEVENLABS_VOICE_STABILITY || "0.5"
              ),
              similarity_boost: Number.parseFloat(
                process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || "0.9"
              ),
              style: Number.parseFloat(
                process.env.ELEVENLABS_VOICE_STYLE || "0.66"
              ),
              use_speaker_boost: process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST === "true"
            }
          })
        });
        if (!speechResponse.ok) {
          throw new Error(
            `ElevenLabs API error: ${speechResponse.statusText}`
          );
        }
        const audioBuffer = await speechResponse.arrayBuffer();
        res.set({
          "Content-Type": "audio/mpeg",
          "Transfer-Encoding": "chunked"
        });
        res.send(Buffer.from(audioBuffer));
      } catch (error) {
        elizaLogger3.error(
          "Error processing message or generating speech:",
          error
        );
        res.status(500).json({
          error: "Error processing message or generating speech",
          details: error.message
        });
      }
    });
    this.app.post("/:agentId/tts", async (req, res) => {
      const text = req.body.text;
      if (!text) {
        res.status(400).send("No text provided");
        return;
      }
      try {
        const elevenLabsApiUrl = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}`;
        const apiKey = process.env.ELEVENLABS_XI_API_KEY;
        if (!apiKey) {
          throw new Error("ELEVENLABS_XI_API_KEY not configured");
        }
        const speechResponse = await fetch(elevenLabsApiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "xi-api-key": apiKey
          },
          body: JSON.stringify({
            text,
            model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
            voice_settings: {
              stability: Number.parseFloat(
                process.env.ELEVENLABS_VOICE_STABILITY || "0.5"
              ),
              similarity_boost: Number.parseFloat(
                process.env.ELEVENLABS_VOICE_SIMILARITY_BOOST || "0.9"
              ),
              style: Number.parseFloat(
                process.env.ELEVENLABS_VOICE_STYLE || "0.66"
              ),
              use_speaker_boost: process.env.ELEVENLABS_VOICE_USE_SPEAKER_BOOST === "true"
            }
          })
        });
        if (!speechResponse.ok) {
          throw new Error(
            `ElevenLabs API error: ${speechResponse.statusText}`
          );
        }
        const audioBuffer = await speechResponse.arrayBuffer();
        res.set({
          "Content-Type": "audio/mpeg",
          "Transfer-Encoding": "chunked"
        });
        res.send(Buffer.from(audioBuffer));
      } catch (error) {
        elizaLogger3.error(
          "Error processing message or generating speech:",
          error
        );
        res.status(500).json({
          error: "Error processing message or generating speech",
          details: error.message
        });
      }
    });
  }
  // agent/src/index.ts:startAgent calls this
  registerAgent(runtime) {
    this.agents.set(runtime.agentId, runtime);
  }
  unregisterAgent(runtime) {
    this.agents.delete(runtime.agentId);
  }
  start(port) {
    this.server = this.app.listen(port, () => {
      elizaLogger3.success(
        `REST API bound to 0.0.0.0:${port}. If running locally, access it at http://localhost:${port}.`
      );
    });
    const gracefulShutdown = () => {
      elizaLogger3.log("Received shutdown signal, closing server...");
      this.server.close(() => {
        elizaLogger3.success("Server closed successfully");
        process.exit(0);
      });
      setTimeout(() => {
        elizaLogger3.error(
          "Could not close connections in time, forcefully shutting down"
        );
        process.exit(1);
      }, 5e3);
    };
    process.on("SIGTERM", gracefulShutdown);
    process.on("SIGINT", gracefulShutdown);
  }
  stop() {
    if (this.server) {
      this.server.close(() => {
        elizaLogger3.success("Server stopped");
      });
    }
  }
};
var DirectClientInterface = {
  start: async (_runtime) => {
    elizaLogger3.log("DirectClientInterface start");
    const client = new DirectClient();
    const serverPort = Number.parseInt(settings.SERVER_PORT || "3000");
    client.start(serverPort);
    return client;
  },
  stop: async (_runtime, client) => {
    if (client instanceof DirectClient) {
      client.stop();
    }
  }
};
var index_default = DirectClientInterface;
export {
  DirectClient,
  DirectClientInterface,
  index_default as default,
  hyperfiHandlerTemplate,
  messageHandlerTemplate
};
//# sourceMappingURL=index.js.map