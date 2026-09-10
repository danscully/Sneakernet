{
	"targets": [
		{
			"target_name": "sneakernet_native",
			"sources": ["fastcopy.cc"],
			"include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
			"defines": ["NAPI_VERSION=8"],
			"cflags!": ["-fno-exceptions"],
			"cflags_cc!": ["-fno-exceptions"],
			"conditions": [
				[
					"OS=='mac'",
					{
						"xcode_settings": {
							"CLANG_CXX_LIBRARY": "libc++",
							"MACOSX_DEPLOYMENT_TARGET": "10.15",
							"GCC_ENABLE_CPP_EXCEPTIONS": "YES"
						}
					}
				],
				[
					"OS=='win'",
					{
						"msvs_settings": {
							"VCCLCompilerTool": {
								"ExceptionHandling": 1
							}
						},
						"defines": ["NOMINMAX", "WIN32_LEAN_AND_MEAN"]
					}
				]
			]
		}
	]
}
