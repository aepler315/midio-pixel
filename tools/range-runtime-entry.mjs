// The only Three.js surface Range v2 uses. tools/build-range-runtime.mjs
// bundles exactly these exports into src/vendor/range/three-range.module.js
// so the browser never imports a CDN or the full library. Add an export
// here only when a runtime module actually needs it.
export {
  WebGLRenderer, WebGLRenderTarget, DepthTexture,
  Scene, Group, Mesh, InstancedMesh, Points, LineSegments,
  PerspectiveCamera, OrthographicCamera,
  BufferGeometry, BufferAttribute, InstancedBufferGeometry, InstancedBufferAttribute, Float32BufferAttribute, Uint32BufferAttribute,
  ShaderMaterial, RawShaderMaterial, MeshBasicMaterial,
  DataTexture, Texture, CanvasTexture,
  Color, Vector2, Vector3, Vector4, Matrix4, Matrix3, Quaternion, Box3, Sphere, Frustum,
  GLSL3, RGBAFormat, RedFormat, RGFormat, UnsignedByteType, FloatType, HalfFloatType, UnsignedIntType,
  LinearFilter, LinearMipmapLinearFilter, NearestFilter, RepeatWrapping, ClampToEdgeWrapping, MirroredRepeatWrapping,
  SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace,
  FrontSide, BackSide, DoubleSide,
  NoBlending, NormalBlending, AdditiveBlending, CustomBlending,
  OneFactor, ZeroFactor, OneMinusSrcAlphaFactor, SrcAlphaFactor, AddEquation,
  LessEqualDepth, EqualDepth, AlwaysDepth,
  NoToneMapping, DynamicDrawUsage, REVISION,
} from 'three';
