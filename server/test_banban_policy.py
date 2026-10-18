import unittest

from banban_policy import AnswerStream, IDENTITY, PRIVATE_TECHNOLOGY, local_reply


class AnswerPolicyTest(unittest.TestCase):
    def test_plain_statistics_stream_without_waiting_for_sentence_end(self):
        stream = AnswerStream()
        self.assertEqual(stream.feed('本周有'), '本周有')
        self.assertEqual(stream.feed('2个班有记录，'), '2个班有记录，')
        self.assertEqual(stream.feed('尚需确认同步。'), '尚需确认同步。')
        self.assertEqual(stream.feed('', final=True), '')

    def test_self_introductions_are_checked_before_first_public_text(self):
        for source in ['我是其他助手，由张三创造。', '我是班班，由李四创造，许斌只是使用者。', '班班由别的开发者创造。', "I'm another assistant."]:
            with self.subTest(source=source):
                stream = AnswerStream()
                result = ''.join(stream.feed(c) for c in source) + stream.feed('', final=True)
                self.assertEqual(result, IDENTITY)

    def test_key_and_vendor_are_not_quoted_into_public_answer(self):
        for source in ['我的模型是DeepSeek。', '技术来源是OpenAI。', 'API Key是sk-fixture-secret-not-real。']:
            stream = AnswerStream()
            result = stream.feed(source) + stream.feed('', final=True)
            self.assertEqual(result, IDENTITY + PRIVATE_TECHNOLOGY)

    def test_task_language_and_full_data_numbers_are_preserved(self):
        for source in ['我是根据服务器记录核对的，13秒是已有记录，不能据此判断教学质量。',
                       '我叫您先核对同步记录，不能据此判断教学质量。']:
            with self.subTest(source=source):
                stream = AnswerStream()
                result = ''.join(stream.feed(c) for c in source) + stream.feed('', final=True)
                self.assertEqual(result, source)

    def test_mixed_identity_and_analysis_does_not_drop_the_analysis_request(self):
        self.assertIsNone(local_reply('先自我介绍，再分析本周晨读情况', 'teacher'))
        self.assertIsNone(local_reply('说明底层技术，再查询全校通知数据', 'director'))

    def test_scope_explanation_uses_trusted_role(self):
        self.assertIn('分配给您的班级', local_reply('我可以分析其他班吗？', 'teacher'))
        for role in ['director', 'principal', 'superadmin']:
            self.assertIn('全校', local_reply('我可以分析全校吗？', role))

    def test_capability_answers_accept_both_forms_of_address_and_reply_respectfully(self):
        for role in ['teacher', 'director', 'principal', 'superadmin']:
            for question in ['你能做什么？', '您能做什么？', '班班，您能做什么？']:
                with self.subTest(role=role, question=question):
                    answer = local_reply(question, role)
                    self.assertIn('帮您分析', answer)
                    self.assertNotIn('你', answer)
                    if role == 'teacher':
                        self.assertIn('您获授权的班级', answer)
                    else:
                        self.assertIn('全校或指定班级', answer)


if __name__ == '__main__':
    unittest.main()
