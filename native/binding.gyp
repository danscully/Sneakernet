{
	"targets": [
		{
			"target_name": "metfilesync_native",
			"sources": ["fastcopy.cc"],
			"include_dirs": [
				"<!@(NODE_PATH=../node_modules node -p \"require('node-addon-api').include\")"
			],
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
						}
					}
				]
			]
		}
	]
}
