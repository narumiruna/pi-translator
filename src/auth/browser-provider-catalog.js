import { antLingProvider } from "@earendil-works/pi-ai/providers/ant-ling";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { basetenProvider } from "@earendil-works/pi-ai/providers/baseten";
import { cerebrasProvider } from "@earendil-works/pi-ai/providers/cerebras";
import { cloudflareAIGatewayProvider } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway";
import { cloudflareWorkersAIProvider } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { fireworksProvider } from "@earendil-works/pi-ai/providers/fireworks";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { googleVertexProvider } from "@earendil-works/pi-ai/providers/google-vertex";
import { groqProvider } from "@earendil-works/pi-ai/providers/groq";
import { huggingfaceProvider } from "@earendil-works/pi-ai/providers/huggingface";
import { kimiCodingProvider } from "@earendil-works/pi-ai/providers/kimi-coding";
import { metaProvider } from "@earendil-works/pi-ai/providers/meta";
import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { minimaxCnProvider } from "@earendil-works/pi-ai/providers/minimax-cn";
import { mistralProvider } from "@earendil-works/pi-ai/providers/mistral";
import { moonshotaiProvider } from "@earendil-works/pi-ai/providers/moonshotai";
import { moonshotaiCnProvider } from "@earendil-works/pi-ai/providers/moonshotai-cn";
import { nvidiaProvider } from "@earendil-works/pi-ai/providers/nvidia";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeProvider } from "@earendil-works/pi-ai/providers/opencode";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { qwenTokenPlanProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan";
import { qwenTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-cn";
import { qwenTokenPlanIndividualProvider } from "@earendil-works/pi-ai/providers/qwen-token-plan-individual";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { togetherProvider } from "@earendil-works/pi-ai/providers/together";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { xaiProvider } from "@earendil-works/pi-ai/providers/xai";
import { xiaomiProvider } from "@earendil-works/pi-ai/providers/xiaomi";
import { xiaomiTokenPlanAmsProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-ams";
import { xiaomiTokenPlanCnProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-cn";
import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import { zaiCodingCnProvider } from "@earendil-works/pi-ai/providers/zai-coding-cn";

const BROWSER_PROVIDER_FACTORIES = Object.freeze([
	antLingProvider,
	anthropicProvider,
	azureProvider,
	basetenProvider,
	cerebrasProvider,
	cloudflareAIGatewayProvider,
	cloudflareWorkersAIProvider,
	deepseekProvider,
	fireworksProvider,
	githubCopilotProvider,
	googleProvider,
	googleVertexProvider,
	groqProvider,
	huggingfaceProvider,
	kimiCodingProvider,
	metaProvider,
	minimaxProvider,
	minimaxCnProvider,
	mistralProvider,
	moonshotaiProvider,
	moonshotaiCnProvider,
	nvidiaProvider,
	openaiProvider,
	openaiCodexProvider,
	opencodeProvider,
	opencodeGoProvider,
	openrouterProvider,
	qwenTokenPlanProvider,
	qwenTokenPlanCnProvider,
	qwenTokenPlanIndividualProvider,
	radiusProvider,
	togetherProvider,
	vercelAIGatewayProvider,
	xaiProvider,
	xiaomiProvider,
	xiaomiTokenPlanAmsProvider,
	xiaomiTokenPlanCnProvider,
	xiaomiTokenPlanSgpProvider,
	zaiProvider,
	zaiCodingCnProvider,
]);

function browserBuiltinProviders() {
	return BROWSER_PROVIDER_FACTORIES.map((createProvider) => createProvider());
}

export { browserBuiltinProviders, openaiCodexProvider };
