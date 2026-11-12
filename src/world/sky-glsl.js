// Shared GLSL used by the sky dome, the ocean and anything that needs to
// evaluate the atmosphere analytically (reflections, fog, ambient term).

export const SKY_UNIFORMS_GLSL = /* glsl */`
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
`;

export const SKY_FUNCTION_GLSL = /* glsl */`
// Analytic atmosphere: horizon -> zenith gradient + sun glow. Cheap and stable.
vec3 skyBase(vec3 d) {
  float y = d.y;
  float t = pow(clamp(y, 0.0, 1.0), 0.55);
  vec3 col = mix(uSkyHorizon, uSkyZenith, t);

  // Below the horizon fade into the sea haze.
  col = mix(col, uSkyGround, smoothstep(0.015, -0.20, y));

  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (0.20 * pow(sd, 5.0) + 0.55 * pow(sd, 80.0) + 7.0 * pow(sd, 2800.0));

  // Slight warm band hugging the horizon opposite the sun for depth.
  float band = exp(-abs(y) * 14.0);
  col += uSkyHorizon * band * 0.12;

  return col;
}
`;
