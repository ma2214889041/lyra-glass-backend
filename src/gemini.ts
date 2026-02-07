// Gemini REST API 直接调用（兼容 Cloudflare Workers）

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const ATMOSPHERE_ENHANCEMENT: Record<string, string> = {
  'High-Fashion Edge': "Editorial avant-garde styling, high-contrast shadows, sharp silhouettes, urban brutalist background. Cold color temperature.",
  'Natural & Friendly': "Warm morning sunlight, soft linen clothing, candid posture, cozy garden or sunlit library setting. Dappled light shadows.",
  'Professional Executive': "Clean office architecture, glass reflections, sharp corporate attire, cool-toned professional lighting with luxury textures.",
  'Athletic Energy': "Dynamic outdoor lighting, premium activewear textures, morning dew or sweat sheen, high-speed shutter aesthetic.",
  'Calm & Intellectual': "Soft diffused interior light, minimalist wooden textures, neutral tones, scholarly atmosphere with soft depth of field."
};

const SYSTEM_INSTRUCTION = `
[CRITICAL EYEWEAR FIDELITY - THIS IS THE CORE REQUIREMENT]

The uploaded eyewear MUST be reproduced with 100% fidelity. This is NON-NEGOTIABLE.

1. FRAME REPRODUCTION
   - Exact frame shape: Do NOT alter curves, angles, or proportions
   - Exact materials: Metal finish (brushed/polished), acetate texture, titanium sheen, etc.
   - Exact colors: Match the exact color tone, gradients, and patterns
   - Exact logos/branding: Reproduce any visible logos, text, or emblems precisely
   - Temple arms: Correct shape, thickness, and hinge details

2. LENS REPRODUCTION
   - If SUNGLASSES with dark/tinted/mirrored lenses: Keep lenses dark/tinted/mirrored. Do NOT make them transparent.
   - If OPTICAL GLASSES with clear lenses: Keep lenses clear and transparent.
   - Maintain exact lens tint color if colored (blue, brown, gradient, etc.)
   - Show realistic lens reflections from environment lighting

3. PHYSICAL INTEGRATION
   - Eyewear must cast natural shadows on face (bridge of nose, temples)
   - Show realistic light reflections on frame surfaces
   - Frame must sit naturally on nose bridge and ears
   - NO "photoshopped sticker" appearance - must look physically present

[FOCUS PROTOCOL]
- The eyewear product is ALWAYS the sharpest element in the image
- Use subtle background blur (bokeh) to emphasize the eyewear

Any deviation from the uploaded eyewear's appearance is an ABSOLUTE FAILURE.
`;

const DEVELOPER_PROMPT = `
[SKIN QUALITY - REALISTIC BUT HEALTHY]
- Natural skin texture with subtle visible pores (NOT overly smooth plastic look)
- HEALTHY, FLAWLESS skin with even tone - NO blemishes, NO acne, NO dark spots
- Natural skin glow and radiance - youthful, well-maintained appearance
- Authentic subsurface scattering for realistic skin translucency
- NO artificial "AI filter" over-smoothing that removes all texture
- Natural, professional makeup (female models) that enhances rather than masks

[TECHNICAL RENDERING]
- PBR (Physically Based Rendering) for accurate material properties
- Realistic light interaction with frame materials (metal reflections, acetate transparency)
- Commercial photography quality with professional lighting
`;

const LIGHTING_INTENT_MAPPING: Record<string, string> = {
  'Butterfly (Paramount)': 'Top-front key light for symmetrical horizontal rim highlights.',
  'Rembrandt': '45-degree directional light for 3D volume and triangular eye-light.',
  'Rim Light': 'Strong backlighting to create a luminous halo separating edges from background.',
  'Softbox Diffused': 'Wraparound soft box illumination, even gradients.',
  'Neon Noir': 'Dual-tone LED lighting with saturated specular reflections.',
  'Golden Hour': 'Warm low-angle natural light (5600K) for honey-toned highlights.'
};

const GENDER_MODEL_SPECS: Record<string, { model: string; features: string; styling: string; pose: string }> = {
  male: {
    model: 'East Asian male model, age 25-35',
    features: 'Strong jawline, natural grooming, confident expression',
    styling: 'Masculine tailored clothing, clean lines',
    pose: 'Confident stance with strong presence, direct gaze'
  },
  female: {
    model: 'East Asian female model, age 25-35',
    features: 'Refined features, sophisticated makeup, elegant styling',
    styling: 'Feminine high-fashion styling, graceful silhouette',
    pose: 'Graceful posture with refined presence, engaging gaze'
  }
};

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType: string;
          data: string;
        };
      }>;
    };
  }>;
  error?: {
    message: string;
    code: number;
  };
}

/**
 * 调用 Gemini REST API
 */
async function callGeminiAPI(
  apiKey: string,
  model: string,
  contents: any,
  config?: {
    systemInstruction?: string;
    responseMimeType?: string;
    temperature?: number;
    imageConfig?: {
      aspectRatio?: string;
      imageSize?: string;
    };
  }
): Promise<GeminiResponse> {
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY 未配置');
  }

  // 使用 Header 传递 API Key，避免在 URL 中暴露（更安全，不会被日志记录）
  const url = `${GEMINI_API_BASE}/${model}:generateContent`;

  const requestBody: any = {
    contents: [{ parts: contents.parts }]
  };

  // 添加系统指令
  if (config?.systemInstruction) {
    requestBody.systemInstruction = {
      parts: [{ text: config.systemInstruction }]
    };
  }

  // 添加生成配置
  const generationConfig: any = {};
  if (config?.responseMimeType) {
    generationConfig.responseMimeType = config.responseMimeType;
  }
  if (config?.temperature !== undefined) {
    generationConfig.temperature = config.temperature;
  }
  // 图片生成配置
  if (config?.imageConfig) {
    generationConfig.responseModalities = ['IMAGE', 'TEXT'];
    // Gemini 1.5/Thinking models sometimes don't support aspectRatio in generationConfig
    // We rely on the prompt to specify aspect ratio if needed, or use specific model capabilities
  }
  if (Object.keys(generationConfig).length > 0) {
    requestBody.generationConfig = generationConfig;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey  // API Key 在 Header 中传递，不会被 URL 日志记录
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[Gemini API Error] Status: ${response.status}, Body: ${errorText}`);
    throw new Error(`Gemini API 请求失败 (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * 从响应中提取图片数据
 */
function extractImageFromResponse(response: GeminiResponse): string {
  if (response.candidates?.[0]?.content?.parts) {
    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
  }
  throw new Error("响应中未找到图片数据");
}

/**
 * 从响应中提取文本
 */
function extractTextFromResponse(response: GeminiResponse): string | null {
  if (response.candidates?.[0]?.content?.parts?.[0]?.text) {
    return response.candidates[0].content.parts[0].text;
  }
  return null;
}

interface ModelConfig {
  framing: string;
  scene: string;
  visualPurpose: string;
  camera: string;
  lens: string;
  lighting: string;
  mood: string;
  skinTexture: string;
  aspectRatio: string;
  modelVibe: string;
}

/**
 * 生成眼镜模特图
 */
export async function generateEyewearImage(
  apiKey: string,
  imageBase64: string,
  size: string,
  modelConfig: ModelConfig,
  gender: string = 'female'
): Promise<string> {
  const model = 'gemini-3-pro-image-preview';

  const atmosphericContext = ATMOSPHERE_ENHANCEMENT[modelConfig.modelVibe] || "";
  const genderSpec = GENDER_MODEL_SPECS[gender] || GENDER_MODEL_SPECS.female;

  const postureInstruction = modelConfig.framing === 'Full Body' || modelConfig.framing === 'Upper Body'
    ? `${genderSpec.pose}. Editorial interaction with environment that emphasizes the eyewear's profile.`
    : `${genderSpec.pose}. Natural head tilt, direct eye contact through lenses, hair styled behind ears to show temples.`;

  const userPrompt = `
  [PRIMARY SUBJECT — THE PRODUCT]
  - Subject: The Eyewear from the reference image. 100% fidelity.
  - Lens Detail: Absolute clarity, eyes visible through lenses if clear.

  [MODEL SPECIFICATIONS]
  - Model: ${genderSpec.model}
  - Features: ${genderSpec.features}
  - Styling: ${genderSpec.styling}

  [ATMOSPHERE & CONTEXT]
  ${atmosphericContext}
  - Environment: ${modelConfig.scene}
  - Mood & Posture: ${postureInstruction}

  [PHOTOGRAPHY SPECIFICATION]
  - Visual Style: ${modelConfig.visualPurpose}
  - Shot Type: ${modelConfig.framing}
  - Gear: ${modelConfig.camera} with ${modelConfig.lens}
  - Lighting: ${LIGHTING_INTENT_MAPPING[modelConfig.lighting] || modelConfig.lighting}
  - Final Finish: ${modelConfig.mood}, skin texture set to ${modelConfig.skinTexture}.
  `;

  const response = await callGeminiAPI(
    apiKey,
    model,
    {
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
        { text: DEVELOPER_PROMPT + "\n" + userPrompt }
      ]
    },
    {
      systemInstruction: SYSTEM_INSTRUCTION,
      imageConfig: {
        aspectRatio: modelConfig.aspectRatio,
        imageSize: size
      }
    }
  );

  return extractImageFromResponse(response);
}

/**
 * 生成海报图
 */
export async function generatePosterImage(
  apiKey: string,
  imageBase64: string,
  config: { title: string; layout: string; material: string },
  size: string,
  aspectRatio: string = '3:4'
): Promise<string> {
  const model = 'gemini-3-pro-image-preview';

  const response = await callGeminiAPI(
    apiKey,
    model,
    {
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
        { text: `Create a luxury eyewear poster. Title: "${config.title}". Style: ${config.layout}. Material: ${config.material}.` }
      ]
    },
    {
      systemInstruction: "You are a luxury brand graphic designer. 100% product fidelity is mandatory. Ensure lens transparency is physically correct.",
      imageConfig: { aspectRatio, imageSize: size }
    }
  );

  return extractImageFromResponse(response);
}

/**
 * 获取提示建议
 */
export async function getPromptSuggestions(
  apiKey: string,
  mode: string,
  imageBase64?: string
): Promise<string[]> {
  const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];

  if (imageBase64) {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: imageBase64
      }
    });
  }

  parts.push({
    text: `Generate 5 creative photography scene descriptions in Chinese for a high-end eyewear commercial shoot. The application mode is ${mode}. Suggestions should be short, evocative, and suitable for a professional fashion shoot. Return as a JSON array of strings.`
  });

  try {
    const response = await callGeminiAPI(
      apiKey,
      'gemini-3-flash-preview',
      { parts },
      { responseMimeType: "application/json" }
    );

    const text = extractTextFromResponse(response);
    if (!text) return getDefaultSuggestions();
    return JSON.parse(text);
  } catch (error) {
    console.error("Prompt suggestion error:", error);
    return getDefaultSuggestions();
  }
}

function getDefaultSuggestions(): string[] {
  return [
    "极简主义水泥工作室，配合硬朗冷色调光影。",
    "自然午后暖阳，透过绿植形成的斑驳光影。",
    "都市霓虹夜景，带有电影感的蓝橘色调对比。",
    "高端行政走廊，通透大面积玻璃墙与城市远景。",
    "法式复古图书馆，柔和的书卷气与自然漫反射光。"
  ];
}

/**
 * 使用模板提示词生成图片
 */
export async function generateFromTemplate(
  apiKey: string,
  eyewearImageBase64: string,
  templatePrompt: string,
  aspectRatio: string = '3:4'
): Promise<string> {
  const model = 'gemini-3-pro-image-preview';

  const fullPrompt = `
${SYSTEM_INSTRUCTION}

${DEVELOPER_PROMPT}

[TEMPLATE-BASED GENERATION]
使用以下提示词，结合上传的眼镜产品图，生成商业级模特试戴效果图：

${templatePrompt}

[CRITICAL EYEWEAR FIDELITY REQUIREMENTS]
- The uploaded eyewear MUST be reproduced with 100% pixel-accurate fidelity
- This could be SUNGLASSES, OPTICAL GLASSES, READING GLASSES, or any eyewear type - preserve its exact nature
- Match exactly: frame shape, frame material, frame color, temple design, ALL branding/logos
- LENS properties: If SUNGLASSES → keep lenses dark/tinted/mirrored as in reference. If OPTICAL glasses → keep lenses clear and transparent
- Model wears the eyewear naturally: proper fit on nose bridge, temples behind ears
- Natural physical shadows cast by frame on face
- Realistic light reflections on lenses and frame

[SKIN QUALITY]
- Natural skin texture with subtle pores - NOT plastic/artificial
- HEALTHY, FLAWLESS skin - NO blemishes, NO spots, even skin tone
- Natural glow and radiance, youthful appearance

[OUTPUT]
- High-quality commercial photography effect
- Sharp focus on the eyewear product
`;

  const response = await callGeminiAPI(
    apiKey,
    model,
    {
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: eyewearImageBase64 } },
        { text: fullPrompt }
      ]
    },
    {
      imageConfig: {
        aspectRatio: aspectRatio,
        imageSize: '1K'
      }
    }
  );

  const imageData = extractImageFromResponse(response);

  // 验证图片数据
  const base64Part = imageData.split(',')[1];
  if (!base64Part || base64Part.length < 100) {
    console.error('[Gemini] Image data too small or empty');
    throw new Error("INVALID_IMAGE_DATA_TOO_SMALL");
  }

  console.log(`[Gemini] Generated image size: ${(base64Part.length / 1024).toFixed(2)} KB`);
  return imageData;
}

/**
 * 优化提示词（管理员专用）
 */
export async function optimizePrompt(
  apiKey: string,
  rawPrompt: string
): Promise<{
  name: string;
  description: string;
  defaultGender: string;
  defaultFraming: string;
  female: string;
  male: string | null;
}> {
  const model = 'gemini-3-flash-preview';

  const systemPrompt = `You are a prompt adapter for eyewear photography. Your task is to make MINIMAL changes to the user's prompt.

[CRITICAL RULES]

1. TREAT INPUT AS RAW STRING - DO NOT CHANGE FORMAT
   - Treat the ENTIRE input as a raw string, whether it's JSON, plain text, or any other format
   - DO NOT parse, restructure, or reformat the input
   - Only INSERT or REPLACE specific text content within the original string

2. EYEWEAR FIDELITY (CRITICAL - ALWAYS REQUIRED)
   - ALWAYS include this statement: "Model wearing the eyewear/sunglasses from the reference image with 100% fidelity"

3. SKIN QUALITY (ALWAYS INCLUDE)
   - Required: "Refined, healthy skin with smooth complexion and natural radiance. Realistic and natural-looking. NO acne, NO moles, NO freckles, NO plastic skin, NO artificial skin, NO AI-generated look."
   - If user prompt has freckles/acne/moles/spots → REMOVE them, replace with "smooth, healthy skin"

4. GENDER ADAPTATION
   - Create TWO versions: female and male
   - Match the SAME VIBE and SCENE appropriately

5. USE PLACEHOLDERS
   - Use {{ethnicity}} for model ethnicity
   - Use {{age}} for age group

6. GENERATE METADATA
   - name: Short Chinese name (2-6 chars)
   - description: Chinese description (10-30 chars)
   - defaultGender: 'male' or 'female'
   - defaultFraming: 'Close-up', 'Upper Body', or 'Full Body'

[OUTPUT FORMAT]
Return ONLY valid JSON:
{
  "name": "模板名称",
  "description": "模板描述",
  "defaultGender": "female",
  "defaultFraming": "Close-up",
  "female": "prompt for female...",
  "male": "prompt for male..."
}`;

  const response = await callGeminiAPI(
    apiKey,
    model,
    {
      parts: [
        { text: `ADAPT this prompt with MINIMAL changes:\n\n${rawPrompt}` }
      ]
    },
    {
      systemInstruction: systemPrompt,
      responseMimeType: "application/json",
      temperature: 0.2
    }
  );

  const text = extractTextFromResponse(response);
  if (text) {
    try {
      return JSON.parse(text.trim());
    } catch {
      return {
        name: '自定义模板',
        description: '用户自定义模板',
        defaultGender: 'female',
        defaultFraming: 'Close-up',
        female: text.trim(),
        male: null
      };
    }
  }
  throw new Error("PROMPT_OPTIMIZATION_FAILED");
}

// ========== 产品图生成 ==========

// 产品图角度描述映射 - 增强版，强调视觉差异
const PRODUCT_ANGLE_PROMPTS: Record<string, string> = {
  'front': `CAMERA POSITION: Directly in front of the eyewear, at eye level.
VISUAL RESULT: You see the FULL FRONT of both lenses symmetrically. Both temple arms angle backwards equally behind the frame. The bridge is centered. This is the classic "face-on" product shot.`,

  'front_45_left': `CAMERA POSITION: 45 degrees to the LEFT of center, at eye level.
VISUAL RESULT: The LEFT side of the frame is closer to camera, LEFT temple arm is clearly visible extending backward. RIGHT lens appears narrower due to perspective. You can see the DEPTH/THICKNESS of the left side of the frame. The frame appears rotated 45° counter-clockwise from front view.`,

  'front_45_right': `CAMERA POSITION: 45 degrees to the RIGHT of center, at eye level.
VISUAL RESULT: The RIGHT side of the frame is closer to camera, RIGHT temple arm is clearly visible extending backward. LEFT lens appears narrower due to perspective. You can see the DEPTH/THICKNESS of the right side of the frame. The frame appears rotated 45° clockwise from front view.`,

  'side_left': `CAMERA POSITION: Directly to the LEFT side, 90 degrees from front.
VISUAL RESULT: Pure profile view. You see the LEFT temple arm in full length from hinge to tip. The frame appears as a thin edge/line. Only ONE lens is visible edge-on. This shows temple arm design and frame thickness.`,

  'side_right': `CAMERA POSITION: Directly to the RIGHT side, 90 degrees from front.
VISUAL RESULT: Pure profile view. You see the RIGHT temple arm in full length from hinge to tip. The frame appears as a thin edge/line. Only ONE lens is visible edge-on. This shows temple arm design and frame thickness.`,

  'top': `CAMERA POSITION: Directly ABOVE the eyewear, looking down (bird's eye view).
VISUAL RESULT: You see the TOP of the frame, both temple arms spread outward like wings. The curved shape of the frame from above. Bridge and nose pads visible from top. Lenses appear as curved surfaces from above.`,

  'perspective': `CAMERA POSITION: Front-right and slightly elevated, 30° above and 45° to the right.
VISUAL RESULT: Dynamic 3/4 view showing three-dimensional form. You see front face partially, right temple arm, and top surface of frame. This is the "hero shot" angle showing depth and craftsmanship.`
};

// 背景风格描述
const BACKGROUND_STYLES: Record<string, string> = {
  'pure_white': 'Pure white seamless background (#FFFFFF), no gradient, studio infinity white cyclorama. Clean e-commerce standard.',
  'light_gray': 'Light gray seamless background (#F0F0F0), subtle neutral tone, professional studio look. Slightly warmer than pure white.',
  'warm_beige': 'Warm beige/cream background (#F5F0E8), soft warm undertone, elegant and inviting. Premium lifestyle feel.',
  'light_blue': 'Light blue-tinted background (#E8F4F8), fresh and modern, clean tech aesthetic. Cool and professional.',
  'black': 'Pure black seamless background (#1A1A1A), dramatic contrast, luxury high-end aesthetic. Product edges clearly defined against dark.',
  'gradient_gray': 'Smooth gradient from light gray (#F8F8F8) at top to medium gray (#E0E0E0) at bottom, creating depth and dimension.'
};

// 产品图系统指令
const PRODUCT_SHOT_SYSTEM_INSTRUCTION = `
[PRODUCT PHOTOGRAPHY SPECIALIST - WHITE BACKGROUND STUDIO]

You are an expert product photographer specializing in luxury eyewear e-commerce imagery, similar to Ray-Ban and Oakley product catalogs.

[#1 CRITICAL RULE - VIEWING ANGLE]
⚠️ You MUST render the eyewear from the EXACT viewing angle specified in the user prompt.
⚠️ Different angle requests MUST produce visually different images.
⚠️ DO NOT always render from frontal view - follow the angle instruction precisely.

Examples of what different angles look like:
- FRONT: Both lenses fully visible, symmetrical, temple arms angled back equally
- 45° LEFT: Left side closer, left temple visible, right lens narrower, frame rotated
- 45° RIGHT: Right side closer, right temple visible, left lens narrower, frame rotated
- SIDE: Only one temple arm visible in full length, frame appears as thin edge
- TOP: Looking down at frame, both temples spread like wings

[ABSOLUTE REQUIREMENTS]

1. VIEWING ANGLE: Follow the exact camera position specified (THIS IS #1 PRIORITY)

2. PRODUCT FIDELITY: The eyewear MUST be reproduced with 100% accuracy
   - Exact frame shape, materials, colors, and textures
   - All logos, branding, and engravings must be visible and sharp
   - Lens properties preserved: clear/tinted/mirrored/gradient as in reference

3. BACKGROUND: Pure studio white background
   - Clean, professional e-commerce standard
   - No distracting elements, patterns, or colors

4. PRODUCT ONLY: Generate the eyewear product ONLY
   - NO human model, NO face, NO hands, NO mannequin head
   - The eyewear appears as if floating or on an invisible display stand

5. LIGHTING: Professional studio lighting adjusted for the viewing angle
   - Soft, even illumination
   - Subtle highlights on frame materials
   - Controlled, realistic reflections on lenses

6. COMPOSITION: Centered, balanced
   - Product occupies 60-70% of frame
   - Sharp focus across entire product

[RENDERING QUALITY]
- Commercial photography quality
- Perfect sharpness edge-to-edge
- Professional color accuracy
`;

/**
 * 生成白色背景产品图
 */
export async function generateProductShot(
  apiKey: string,
  eyewearImageBase64: string,
  angle: string,
  config: {
    backgroundColor: string;
    reflectionEnabled: boolean;
    shadowStyle: string;
    aspectRatio: string;
  }
): Promise<string> {
  const model = 'gemini-3-pro-image-preview';

  const angleDescription = PRODUCT_ANGLE_PROMPTS[angle] || PRODUCT_ANGLE_PROMPTS['front'];
  const backgroundDescription = BACKGROUND_STYLES[config.backgroundColor] || BACKGROUND_STYLES['pure_white'];

  // 构建阴影描述
  let shadowDescription = '';
  if (config.shadowStyle === 'soft') {
    shadowDescription = 'Subtle, soft diffused shadow beneath the product, creating natural grounding effect.';
  } else if (config.shadowStyle === 'dramatic') {
    shadowDescription = 'Defined shadow with soft edges, emphasizing product elevation and premium feel.';
  } else {
    shadowDescription = 'No shadow, pure floating product on seamless white background.';
  }

  // 倒影描述
  const reflectionDescription = config.reflectionEnabled
    ? 'Subtle mirror-like reflection on the surface beneath the product, fading gradually into white.'
    : 'No reflection, clean matte surface finish.';

  const userPrompt = `
[CRITICAL - VIEWING ANGLE IS THE #1 PRIORITY]

⚠️ THE VIEWING ANGLE BELOW IS MANDATORY. DO NOT DEFAULT TO FRONTAL VIEW.
⚠️ The output image MUST show the eyewear from the EXACT angle specified.
⚠️ If the angle says "45 degrees left", the camera MUST be positioned 45° to the left.
⚠️ Each angle produces a VISUALLY DIFFERENT image - not the same image.

REQUIRED VIEWING ANGLE:
${angleDescription}

---

[PRODUCT SHOT GENERATION - E-COMMERCE CATALOG STYLE]

Generate a professional e-commerce product photograph of the eyewear from the reference image.
This should look like a Ray-Ban or Oakley official product image.
The eyewear must be shown from the EXACT viewing angle specified above.

[BACKGROUND]
${backgroundDescription}

[SHADOW & REFLECTION]
${shadowDescription}
${reflectionDescription}

[PRODUCT REQUIREMENTS]
- Reproduce the eyewear with 100% fidelity to the reference image
- Frame shape, color, material texture: EXACT match to original
- Lens properties: Preserve original (clear/dark/mirrored/gradient tint)
- All branding, logos, engravings: Sharp and clearly visible
- Temple arms: Naturally extended position, showing full design

[LIGHTING SETUP]
- Professional 3-point studio lighting
- Main light: Large softbox from above-front (45° angle)
- Fill light: Soft reflector from below to minimize harsh shadows
- Rim light: Subtle edge definition to separate product from background
- Result: Even illumination, controlled highlights, premium material showcase

[COMPOSITION]
- Product perfectly centered in frame
- Occupies 65-70% of canvas
- Perfect horizontal alignment with level horizon
- Balanced negative space around product

[TECHNICAL SPECIFICATIONS]
- Commercial product photography quality
- 8K equivalent sharpness and detail
- Accurate color reproduction
- Zero post-processing artifacts
- Clean, professional finish

OUTPUT: A single, pristine product image suitable for luxury e-commerce catalog and brand website.
`;

  const response = await callGeminiAPI(
    apiKey,
    model,
    {
      parts: [
        { inlineData: { mimeType: "image/jpeg", data: eyewearImageBase64 } },
        { text: userPrompt }
      ]
    },
    {
      systemInstruction: PRODUCT_SHOT_SYSTEM_INSTRUCTION,
      imageConfig: {
        aspectRatio: config.aspectRatio,
        imageSize: '1K'
      }
    }
  );

  const imageData = extractImageFromResponse(response);

  // 验证图片数据
  const base64Part = imageData.split(',')[1];
  if (!base64Part || base64Part.length < 100) {
    console.error('[Gemini] Product shot image data too small or empty');
    throw new Error("INVALID_IMAGE_DATA_TOO_SMALL");
  }

  console.log(`[Gemini] Generated product shot (${angle}): ${(base64Part.length / 1024).toFixed(2)} KB`);
  return imageData;
}
