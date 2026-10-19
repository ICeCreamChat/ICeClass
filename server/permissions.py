"""School responsibilities and their live class scopes."""
from reading import class_grade

GRADES = ('高一', '高二', '高三')
STAFF_ROLES = {'teacher', 'grade_leader', 'director', 'principal'}
SCHOOL_ROLES = {'superadmin', 'principal'}
MANAGER_ROLES = SCHOOL_ROLES | {'director', 'grade_leader'}
ROLE_LABELS = {'superadmin': '超级管理员', 'principal': '校长', 'director': '主任',
               'grade_leader': '年级部长', 'teacher': '班主任教师'}


def scope_sql(user, class_id='c.id'):
    """Return a SQL predicate and bound arguments; class_id is a code-owned expression."""
    role = user['role']
    if role in SCHOOL_ROLES:
        return '1', ()
    if role == 'director':
        return f"EXISTS (SELECT 1 FROM classes scope_class WHERE scope_class.id={class_id} AND class_grade(scope_class.name) IN ('高一','高二','高三'))", ()
    if role == 'grade_leader':
        return f'EXISTS (SELECT 1 FROM classes scope_class JOIN user_grades ug ON ug.grade=class_grade(scope_class.name) WHERE scope_class.id={class_id} AND ug.user_id=?)', (user['id'],)
    if role == 'teacher':
        return f'EXISTS (SELECT 1 FROM teacher_classes scope_tc WHERE scope_tc.class_id={class_id} AND scope_tc.user_id=?)', (user['id'],)
    return '0', ()


def class_ids(db, user):
    clause, args = scope_sql(user)
    return {c['id'] for c in db.all(f'SELECT c.id FROM classes c WHERE {clause}', args)}


def can_manage_grade(db, user, grade):
    if user['role'] in SCHOOL_ROLES:
        return True
    if user['role'] == 'director':
        return grade in GRADES
    return user['role'] == 'grade_leader' and bool(db.one(
        'SELECT 1 FROM user_grades WHERE user_id=? AND grade=?', (user['id'], grade)))


def managed_roles(user):
    return {'superadmin': STAFF_ROLES, 'principal': STAFF_ROLES,
            'director': {'grade_leader', 'teacher'}, 'grade_leader': {'teacher'}}.get(user['role'], set())


def can_manage_user(db, actor, target):
    if target['id'] == actor['id'] or target['role'] not in managed_roles(actor):
        return False
    if actor['role'] in SCHOOL_ROLES:
        return True
    if target['role'] == 'grade_leader':
        grade = db.one('SELECT grade FROM user_grades WHERE user_id=?', (target['id'],))
        return actor['role'] == 'director' and bool(grade)
    assigned = class_ids(db, target)
    return bool(assigned) and assigned.issubset(class_ids(db, actor))


def capabilities(user):
    return {'schoolAdmin': user['role'] in SCHOOL_ROLES,
            'manageUsers': user['role'] in MANAGER_ROLES,
            'manageClasses': user['role'] in MANAGER_ROLES,
            'controlClassrooms': True,
            'assignableRoles': [r for r in ('principal', 'director', 'grade_leader', 'teacher') if r in managed_roles(user)]}
