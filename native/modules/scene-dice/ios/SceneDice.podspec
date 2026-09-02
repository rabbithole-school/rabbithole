Pod::Spec.new do |s|
  s.name           = 'SceneDice'
  s.version        = '1.0.0'
  s.summary        = 'SceneKit 3D dice (d6/d20) with physics for Rabbithole'
  s.description    = 'A local Expo module hosting an SCNView that rolls polyhedral dice with rigid-body physics and reports settled values.'
  s.author         = 'Rabbithole'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.resource_bundles = {
    'SceneDiceAssets' => ['assets/*.png']
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
