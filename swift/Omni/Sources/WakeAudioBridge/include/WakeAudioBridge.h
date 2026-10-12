#import <AVFoundation/AVFoundation.h>
NS_ASSUME_NONNULL_BEGIN
/// Keeps AVFAudio startup exceptions entirely within Objective-C frames.
@interface OmniWakeAudioBridge : NSObject
+ (BOOL)installTapOnNode:(AVAudioNode *)node block:(AVAudioNodeTapBlock)block error:(NSError * _Nullable * _Nullable)error;
+ (BOOL)prepareAndStartEngine:(AVAudioEngine *)engine error:(NSError * _Nullable * _Nullable)error;
@end
NS_ASSUME_NONNULL_END
